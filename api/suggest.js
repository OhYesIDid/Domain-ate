import { createPublicKey, verify } from 'crypto';

export const config = { maxDuration: 300 };

const FREE_LIMIT    = 5;
const MAX_CHECKS    = 60;   // budget for check_domain tool calls
const TARGET        = 10;   // domains to find and submit

// ── Clerk JWT verification ──────────────────────────────────────────────────

const jwksCache = {};

async function getJwksForIssuer(iss) {
  const now = Date.now();
  if (jwksCache[iss] && now - jwksCache[iss].at < 3_600_000) return jwksCache[iss].keys;
  const res = await fetch(`${iss}/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys } = await res.json();
  jwksCache[iss] = { keys, at: now };
  return keys;
}

async function verifyClerkToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header  = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.exp * 1000 < Date.now()) return null;
    if (!payload.iss) return null;
    const keys = await getJwksForIssuer(payload.iss);
    const jwk  = keys.find(k => k.kid === header.kid);
    if (!jwk) return null;
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    const valid = verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2], 'base64url')
    );
    return valid ? payload : null;
  } catch (err) {
    console.warn('verifyClerkToken error:', err.message);
    return null;
  }
}

// ── Usage tracking ──────────────────────────────────────────────────────────

function usageKey(userId) {
  return `usage:${userId}:${new Date().toISOString().slice(0, 7)}`;
}

async function getUsage(userId) {
  const res = await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/get/${usageKey(userId)}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
  const data = await res.json();
  return parseInt(data.result || '0', 10);
}

async function incrementUsage(userId) {
  const key = usageKey(userId);
  await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/incr/${key}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
  await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/expire/${key}/3024000`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
}

// ── Redis helpers ────────────────────────────────────────────────────────────

async function redisGet(key) {
  try {
    const res = await fetch(
      `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
    );
    const data = await res.json();
    return data.result ?? null;
  } catch { return null; }
}

async function redisSet(key, value, ttl) {
  try {
    const url = ttl
      ? `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}?EX=${ttl}`
      : `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
    await fetch(url, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
  } catch {}
}

async function redisIncr(key) {
  try {
    await fetch(
      `${process.env.UPSTASH_REDIS_REST_URL}/incr/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
    );
  } catch {}
}

// ── Domain availability cache ─────────────────────────────────────────────────
// Taken   → 6 months  (quality domains stay taken; non-renewals get snapped up anyway)
// Premium → 6 months  (premium status is stable)
// Available → 48 hours (can get registered at any time)
// Unknown → not cached (retry next time)

async function getCached(domain) {
  try {
    const [taken, avail, premium] = await Promise.all([
      redisGet(`taken:${domain}`),
      redisGet(`avail:${domain}`),
      redisGet(`premium:${domain}`),
    ]);
    if (taken   !== null) return { available: false };
    if (premium !== null) return { available: true, premium: true, price: parseFloat(premium) };
    if (avail   !== null) return { available: true };
    return null;
  } catch { return null; }
}

async function setCache(domain, available, premiumPrice = null) {
  if (available === false) {
    await redisSet(`taken:${domain}`,   '1', 15_552_000);          // 6 months
  } else if (available === true && premiumPrice) {
    await redisSet(`premium:${domain}`, String(premiumPrice), 15_552_000);
  } else if (available === true) {
    await redisSet(`avail:${domain}`,   '1', 172_800);              // 48 hours
  }
  // null = RDAP inconclusive → don't cache, retry next time
}

// ── TLD availability stats ────────────────────────────────────────────────────
// Running counters per TLD. After enough data accumulates, the prompt
// references real availability rates so Claude aims where headroom exists.

async function recordTld(tld, available, ctx = 'global') {
  const k  = tld.replace(/\./g, '_');
  const ck = `${ctx}:${k}`;
  redisIncr(`tld:${k}:checked`).catch(() => {});
  redisIncr(`tld:${ck}:checked`).catch(() => {});
  if (available === true) {
    redisIncr(`tld:${k}:avail`).catch(() => {});
    redisIncr(`tld:${ck}:avail`).catch(() => {});
  }
}

async function getTldStats(ctx = 'global') {
  const tlds = ['.com', '.io', '.app', '.co', '.ai', '.dev'];
  const stats = {};
  try {
    const rows = await Promise.all(tlds.map(async tld => {
      const k  = tld.replace(/\./g, '_');
      const ck = `${ctx}:${k}`;
      const [cc, ca, gc, ga] = await Promise.all([
        redisGet(`tld:${ck}:checked`), redisGet(`tld:${ck}:avail`),
        redisGet(`tld:${k}:checked`),  redisGet(`tld:${k}:avail`),
      ]);
      return {
        tld,
        ctxChecked: parseInt(cc || '0'), ctxAvail: parseInt(ca || '0'),
        glbChecked: parseInt(gc || '0'), glbAvail: parseInt(ga || '0'),
      };
    }));
    for (const { tld, ctxChecked, ctxAvail, glbChecked, glbAvail } of rows) {
      if (ctxChecked >= 30)      stats[tld] = Math.round((ctxAvail / ctxChecked) * 100);
      else if (glbChecked >= 50) stats[tld] = Math.round((glbAvail / glbChecked) * 100);
    }
  } catch {}
  return stats;
}

// ── RDAP (module-level bootstrap cache) ──────────────────────────────────────

let _bootstrap   = null;
let _bootstrapAt = 0;

async function getBootstrap() {
  if (_bootstrap && Date.now() - _bootstrapAt < 3_600_000) return _bootstrap;
  const res    = await fetch('https://data.iana.org/rdap/dns.json', { signal: AbortSignal.timeout(8000) });
  _bootstrap   = await res.json();
  _bootstrapAt = Date.now();
  return _bootstrap;
}

async function rdapCheck(domain) {
  try {
    const tld       = domain.slice(domain.indexOf('.') + 1);
    const bootstrap = await getBootstrap();
    let   rdapBase  = null;
    for (const [tlds, urls] of bootstrap.services) {
      if (tlds.includes(tld) && urls.length > 0) { rdapBase = urls[0].replace(/\/$/, ''); break; }
    }
    if (!rdapBase) return null;
    const res = await fetch(`${rdapBase}/domain/${domain}`, { signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return true;
    if (res.status === 200) return false;
    return null;
  } catch { return null; }
}

// ── Namecheap batch availability check ───────────────────────────────────────
// Checks up to 50 domains in a single API call.
// Returns a map of domain → { available: bool|null, premium: bool, price: number|null }
// Falls back to parallel RDAP if Namecheap credentials are absent or the call fails.

async function batchCheck(domains, clientIp = '127.0.0.1') {
  const ncApiKey  = process.env.NAMECHEAP_API_KEY;
  const ncApiUser = process.env.NAMECHEAP_API_USER;

  if (ncApiKey && ncApiUser) {
    try {
      const url =
        `https://api.namecheap.com/xml.response` +
        `?ApiUser=${encodeURIComponent(ncApiUser)}` +
        `&ApiKey=${encodeURIComponent(ncApiKey)}` +
        `&UserName=${encodeURIComponent(ncApiUser)}` +
        `&Command=namecheap.domains.check` +
        `&ClientIp=${encodeURIComponent(clientIp)}` +
        `&DomainList=${encodeURIComponent(domains.join(','))}`;

      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const xml = await res.text();

      if (xml.includes('Status="ERROR"') || xml.includes('ErrCount>0<')) {
        throw new Error('Namecheap API error');
      }

      const results = {};
      const regex   = /DomainCheckResult([^>]+)/gi;
      let match;
      while ((match = regex.exec(xml)) !== null) {
        const attrs     = match[1];
        const domain    = (attrs.match(/Domain="([^"]+)"/i)               || [])[1]?.toLowerCase();
        const available = (attrs.match(/Available="([^"]+)"/i)            || [])[1]?.toLowerCase() === 'true';
        const isPremium = (attrs.match(/IsPremiumName="([^"]+)"/i)        || [])[1]?.toLowerCase() === 'true';
        const price     = parseFloat((attrs.match(/PremiumRegistrationPrice="([^"]+)"/i) || [])[1] || '');
        if (domain) results[domain] = { available, premium: isPremium, price: isNaN(price) ? null : price };
      }

      if (Object.keys(results).length > 0) return results;
      throw new Error('No results parsed');
    } catch (err) {
      console.warn('Namecheap batch check failed, falling back to RDAP:', err.message);
    }
  }

  // RDAP fallback — parallel
  const settled = await Promise.all(domains.map(async d => ({ d, available: await rdapCheck(d) })));
  return Object.fromEntries(settled.map(({ d, available }) => [d, { available, premium: false, price: null }]));
}

// ── Quality gate ──────────────────────────────────────────────────────────────
// Called before RDAP — no network required.
// Returns null on pass, or a string describing why it failed.
// seenNames = names that already passed this gate (for diversity enforcement).

// Only block truly generic functional suffixes — not valid name parts like flow/core/link
const PADDING_SUFFIXES = ['app', 'hq', 'get', 'now', 'go', 'try', 'my', 'use', 'hub', 'pro', 'base', 'labs'];
const PADDING_PREFIXES = ['get', 'my', 'the', 'use', 'try'];

// Reject names within edit-distance 1 (single-char typos) of known brands only
const KNOWN_BRANDS = ['stripe', 'slack', 'spotify', 'notion', 'figma', 'canva', 'shopify', 'hubspot', 'dropbox', 'airbnb', 'twitter', 'tiktok', 'google', 'amazon', 'paypal', 'square', 'twilio', 'zendesk', 'atlassian', 'github', 'gitlab', 'jira', 'trello', 'asana', 'monday', 'clickup', 'discord', 'telegram', 'whatsapp', 'reddit', 'medium', 'substack', 'webflow', 'framer', 'airtable', 'linear', 'todoist', 'intercom', 'salesforce', 'netflix', 'adobe', 'microsoft', 'facebook', 'instagram', 'linkedin', 'pinterest', 'snapchat', 'basecamp', 'mailchimp', 'sendgrid', 'klaviyo', 'mixpanel', 'amplitude', 'hotjar', 'datadog', 'cloudflare', 'vercel', 'netlify', 'heroku', 'supabase', 'firebase'];

// Strip common branding affixes to extract the semantic root for concept-dedup
function extractRoot(name) {
  const suffixes = ['ify', 'ize', 'ous', 'ful', 'ble', 'era', 'ova', 'io', 'ai', 'ly'];
  const prefixes = ['get', 'my', 'the', 'use', 'try'];
  let root = name;
  for (const p of prefixes) {
    if (root.startsWith(p) && root.length > p.length + 3) { root = root.slice(p.length); break; }
  }
  for (const s of suffixes) {
    if (root.endsWith(s) && root.length > s.length + 2) { root = root.slice(0, -s.length); break; }
  }
  return root;
}

function editDist(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function qualityGate(domain, seenNames, submittedNames = []) {
  const dot = domain.lastIndexOf('.');
  if (dot === -1) return 'missing TLD';
  const name = domain.slice(0, dot).toLowerCase();
  if (name.length < 5)  return 'too short (min 5 chars)';
  if (name.length > 12) return 'too long (max 12 chars)';
  if (/[0-9-]/.test(name)) return 'contains digits or hyphens';
  const vowelRatio = (name.match(/[aeiou]/gi) || []).length / name.length;
  if (vowelRatio < 0.2 || vowelRatio > 0.6) return 'poor vowel ratio — likely unpronounceable';
  if (/[^aeiou]{4,}/i.test(name))           return 'consonant cluster — unpronounceable';
  const suffixOffender = PADDING_SUFFIXES.find(p => name !== p && name.endsWith(p) && name.length > p.length + 2);
  if (suffixOffender) return `padding suffix detected — ends in "${suffixOffender}"`;
  const prefixOffender = PADDING_PREFIXES.find(p => name !== p && name.startsWith(p) && name.length > p.length + 3);
  if (prefixOffender) return `padding prefix detected — starts with "${prefixOffender}"`;
  for (const brand of KNOWN_BRANDS) {
    if (editDist(name, brand) <= 1) return `too similar to known brand "${brand}" — avoid trademark conflicts`;
  }
  for (const seen of seenNames) {
    if (editDist(name, seen) <= 2) return `too similar to already-tried "${seen}" — invent a different concept`;
  }
  // Semantic concept dedup — reject if new name shares root with already-submitted domain
  const newRoot = extractRoot(name);
  for (const sub of submittedNames) {
    const subRoot = extractRoot(sub);
    if (newRoot.length >= 5 && subRoot.length >= 5 && (newRoot.includes(subRoot) || subRoot.includes(newRoot))) {
      return `shares concept root with already-submitted "${sub}" — explore a genuinely different direction`;
    }
  }
  return null; // pass
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'check_domain',
    description:
      'Check if a domain name passes quality standards and is available for registration. ' +
      'Quality requirements: 5–12 characters, pronounceable (healthy vowel ratio, no consonant clusters), ' +
      'no padding suffixes (app/hq/get/go/try/my/use/hub/pro), no digits or hyphens. ' +
      'If the result is TAKEN: abandon that concept entirely — never pad, never append, never retry with minor variations.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Full domain with TLD, lowercase, e.g. "threadwise.io"' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'submit_domain',
    description:
      'Submit a confirmed-available domain as a final suggestion. ' +
      'Only call this immediately after check_domain returns { available: true } for that exact domain.',
    input_schema: {
      type: 'object',
      properties: {
        name:       { type: 'string',  description: 'Domain name without TLD, lowercase' },
        tld:        { type: 'string',  description: 'TLD including dot, e.g. ".io"' },
        style:      { type: 'string',  enum: ['brandable', 'keyword', 'hybrid'] },
        rationale:  { type: 'string',  description: 'Why this name suits this specific business (max 15 words)' },
        confidence: { type: 'integer', minimum: 1, maximum: 10, description: 'How well this name fits the business (1=poor fit, 10=perfect)' },
      },
      required: ['name', 'tld', 'style', 'rationale', 'confidence'],
    },
  },
];

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Client IP — passed to Namecheap batch API (must match a whitelisted IP in Namecheap account)
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || '127.0.0.1';

  // ── Auth ─────────────────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sign in to generate domain suggestions.' });

  const payload = await verifyClerkToken(token);
  if (!payload)  return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });

  const userId = payload.sub;
  // Clerk puts public_metadata in the JWT with an underscore key
  const plan   = payload.public_metadata?.plan
               || payload.publicMetadata?.plan
               || payload.metadata?.plan
               || 'free';

  // ── Usage check (free plan, JSON response before SSE starts) ─────────────────
  if (plan !== 'pro') {
    let usage = 0;
    try {
      usage = await getUsage(userId);
    } catch (e) {
      console.error('Usage check Redis error:', e.message);
      // Fail-closed: if Redis is down we cannot verify the limit, block the request
      return res.status(503).json({ error: 'Usage service temporarily unavailable. Please try again in a moment.' });
    }
    if (usage >= FREE_LIMIT) {
      return res.status(402).json({
        error: `You've used all ${FREE_LIMIT} free searches this month. Upgrade to Pro for unlimited access.`,
        usage,
        limit: FREE_LIMIT,
      });
    }
  }

  const { description, answers } = req.body;
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid description' });
  }

  // ── Switch to SSE ─────────────────────────────────────────────────────────────
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // ── Build prompt ──────────────────────────────────────────────────────────────
  const geo      = answers?.geo      || 'global';
  const audience = answers?.audience || 'both';

  // ── TLD stats for dynamic prompt (scoped to this audience+geo context) ───────
  const ctx         = `${audience}:${geo}`;
  const tldStats    = await getTldStats(ctx);
  const tldStatsStr = Object.keys(tldStats).length >= 3
    ? '\nLIVE AVAILABILITY DATA from recent searches:\n' +
      Object.entries(tldStats).map(([t, r]) => `${t}: ${r}% available`).join(' | ') +
      '\nWeight your TLD choices toward higher availability rates.\n'
    : '';

  const tldRules = {
    global:
      'Include at least 4 .com suggestions — they carry universal trust. ' +
      'The remaining 6 can use .io, .app, .co, .ai — choose whichever best fits each name.',
    us:
      'Include at least 5 .com suggestions — US audiences strongly equate .com with credibility. ' +
      'The remaining 5 can use .io, .app, or .co.',
    europe:
      'Include at least 3 .com suggestions for global reach. ' +
      'You may also suggest .eu or .co.uk to signal European presence. ' +
      'Remaining slots can use .io, .app, or .co.',
    asia:
      'Include at least 3 .com suggestions — still the most trusted TLD in Asia-Pacific. ' +
      'You may also suggest .asia or .co for regional relevance. ' +
      'Remaining slots can use .io or .app.',
  }[geo] || 'Include at least 4 .com suggestions. Remaining can use .io, .app, .co, or .ai.';

  const audienceTone = {
    b2b:
      'Tone: professional and authoritative. Names must convey reliability, expertise, and trustworthiness. ' +
      'Avoid slang, playful misspellings, or anything casual or consumer-facing.',
    b2c:
      'Tone: energetic and approachable. Emotional and lifestyle-oriented names work well. ' +
      'Colloquial language is acceptable. Focus on how the name makes a customer feel.',
    genz:
      'Tone: internet-native and bold. Embrace neologisms, unexpected spellings, and irreverent language. ' +
      'Avoid corporate-sounding or formal names.',
    both:
      'Tone: balance professionalism with approachability. ' +
      'Names must feel credible in a pitch deck AND welcoming on a consumer homepage.',
  }[audience] || 'Tone: balance professionalism with approachability.';

  const systemPrompt =
    'You are a world-class domain name consultant with 15 years of experience helping startups and businesses ' +
    'secure memorable, brandable domain names. You understand linguistics, brand psychology, and how domain ' +
    'choices affect conversion and recall.\n\n' +
    'You have two tools:\n' +
    '• check_domain — verifies quality standards and real-time availability\n' +
    '• submit_domain — records a confirmed-available domain (include an honest confidence score 1–10 for how well it fits this specific business)\n\n' +
    `Your goal: submit exactly ${TARGET} confirmed-available domains.\n` +
    `Budget: at most ${MAX_CHECKS} check_domain calls — use them wisely.\n\n` +
    'CRITICAL RULES:\n' +
    '• When a domain is TAKEN: abandon that entire concept and invent something genuinely new\n' +
    '• Never pad, never append, never retry with a single letter changed\n' +
    '• Never submit a name that is similar to an existing brand (Stripe, Slack, Shopify, etc.)\n' +
    '• Each submission must come from a distinct creative direction — no shared concept roots\n' +
    '• The quality gate automatically rejects near-duplicates, padding prefixes/suffixes, and brand clashes';

  const geoLabel      = { global: 'Global (worldwide)', us: 'United States', europe: 'Europe', asia: 'Asia-Pacific' }[geo] || 'Global';
  const audienceLabel = { b2b: 'Businesses (B2B)', b2c: 'Consumers (B2C)', genz: 'Gen Z / young consumers', both: 'Mixed (B2B + B2C)' }[audience] || 'Mixed';

  const styleMix = {
    b2b:  `- 2 brandable (coined/abstract names that feel premium and trustworthy)\n- 4 keyword (descriptive names that signal what the business does — clarity builds B2B trust)\n- 4 hybrid (brand+keyword blends like Dropbox, Mailchimp, Basecamp)`,
    b2c:  `- 5 brandable (invented/abstract — like Spotify, Canva, Notion)\n- 2 keyword (descriptive/literal)\n- 3 hybrid (brand + keyword blend like Pinterest, Snapchat)`,
    genz: `- 7 brandable (bold, internet-native coined names — unexpected, energetic, memorable)\n- 1 keyword (only if genuinely creative, not generic)\n- 2 hybrid`,
    both: `- 4 brandable (invented/abstract — like Spotify, Slack, Notion)\n- 3 keyword (descriptive/literal — like Basecamp, Mailchimp)\n- 3 hybrid (brand + keyword blend — like Pinterest, Dropbox)`,
  }[audience] || `- 4 brandable\n- 3 keyword\n- 3 hybrid`;

  const userMessage =
    `Find exactly ${TARGET} available domain names for this business.\n\n` +
    `BUSINESS DETAILS\n` +
    `Description: ${description}\n` +
    `Target market: ${geoLabel}\n` +
    `Target audience: ${audienceLabel}\n\n` +
    `AUDIENCE TONE\n${audienceTone}\n\n` +
    `TLD RULES FOR THIS MARKET\n${tldRules}\n` +
    tldStatsStr + '\n' +
    `STYLE MIX (across your ${TARGET} submissions)\n` +
    styleMix + '\n\n' +
    `NAMING REQUIREMENTS\n` +
    `- 5–12 characters (name only, excluding TLD)\n` +
    `- Memorable and easy to spell after hearing it once\n` +
    `- No hyphens, no numbers\n` +
    `- Do NOT submit names similar to existing brands (Stripe, Slack, Shopify, Notion, etc.)\n` +
    `- Each submission must come from a genuinely different creative concept\n\n` +
    `AVAILABILITY STRATEGY\n` +
    `Most obvious .com combinations are already registered. To find available names:\n` +
    `- Favour coined/invented words and unexpected combinations over common English word pairs\n` +
    `- For .com, include at least one non-dictionary element (blend, truncation, suffix like -ly/-ify/-io/-era/-ova)\n` +
    `- Freely use .io, .app, .co, .ai — these have far more availability than .com\n` +
    `- The more specific and creative the name, the more likely it is free\n\n` +
    `WORKFLOW\n` +
    `1. Think of a strong, original name concept suited to this specific business\n` +
    `2. Call check_domain — inspect the result carefully\n` +
    `3. If available → immediately call submit_domain with an honest confidence score (1–10)\n` +
    `4. If taken or rejected → invent a completely different concept, do not retry variations\n` +
    `5. Repeat until you have submitted ${TARGET} domains`;

  // ── Agentic tool-use loop ─────────────────────────────────────────────────────
  const messages        = [{ role: 'user', content: userMessage }];
  let checksUsed        = 0;
  let submitted         = 0;
  let budgetWarned      = false;
  const seenNames       = []; // names that passed quality gate — edit-distance diversity
  const submittedNames  = []; // names actually submitted — semantic concept dedup

  // ── Gemini format converters ──────────────────────────────────────────────────

  // Convert Anthropic-format messages → Gemini contents array.
  // Builds a toolIdToName map on the fly so tool_result blocks can get their name.
  function toGeminiContents(msgs) {
    const idToName = {};
    const contents = [];
    for (const msg of msgs) {
      const role    = msg.role === 'assistant' ? 'model' : 'user';
      const payload = msg.content;
      const parts   = [];

      if (typeof payload === 'string') {
        parts.push({ text: payload });
      } else {
        for (const block of payload) {
          if (block.type === 'text' && block.text) {
            parts.push({ text: block.text });
          } else if (block.type === 'tool_use') {
            idToName[block.id] = block.name;
            parts.push({ functionCall: { name: block.name, args: block.input || {} } });
          } else if (block.type === 'tool_result') {
            const name = idToName[block.tool_use_id] || 'check_domain';
            let response;
            try { response = JSON.parse(block.content); } catch { response = { result: String(block.content) }; }
            parts.push({ functionResponse: { name, response } });
          }
        }
      }
      if (parts.length > 0) contents.push({ role, parts });
    }
    return contents;
  }

  // Convert Gemini response → Anthropic-format { content, stop_reason }.
  function fromGeminiResponse(geminiData) {
    const candidate = geminiData.candidates?.[0];
    if (!candidate) throw new Error(`Gemini: no candidates — ${JSON.stringify(geminiData).slice(0, 200)}`);
    const parts   = candidate.content?.parts || [];
    const content = [];
    let   hasFn   = false;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.text)         content.push({ type: 'text', text: p.text });
      if (p.functionCall) {
        hasFn = true;
        content.push({ type: 'tool_use', id: `g_${i}`, name: p.functionCall.name, input: p.functionCall.args || {} });
      }
    }
    return { content, stop_reason: hasFn ? 'tool_use' : 'end_turn' };
  }

  // ── Gemini API call (free-tier fallback) with retry on 429 ───────────────────
  async function callGemini(messages, systemPrompt) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY not set');
    const functionDeclarations = TOOLS.map(t => ({
      name:        t.name,
      description: t.description,
      parameters:  t.input_schema,
    }));
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents:          toGeminiContents(messages),
      tools:             [{ functionDeclarations }],
      generationConfig:  { maxOutputTokens: 2048 },
    });
    // gemini-2.5-flash-lite: 15 RPM, 1,000 RPD on free tier (best free-tier headroom)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res  = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(60_000) });
        const data = await res.json();
        if (res.ok) return fromGeminiResponse(data);
        if (res.status === 429 && attempt < 2) {
          const delay = [7000, 15000][attempt]; // 7s, 15s — respects 15 RPM (4s min) with buffer
          console.warn(`Gemini 429 — retry in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        lastErr = new Error(`Gemini API: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise(r => setTimeout(r, [7000, 15000][attempt]));
      }
    }
    throw lastErr;
  }

  // ── Primary: Anthropic with retry; fallback: Gemini (rate-limit only) ────────
  async function callLLM(messages, systemPrompt) {
    const body    = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4096, system: systemPrompt, tools: TOOLS, messages });
    const headers = { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    let lastErr;
    let rateLimited = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res  = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body, signal: AbortSignal.timeout(60_000) });
        const data = await res.json();
        if (res.ok) return data;
        if ((res.status === 429 || res.status === 529) && attempt < 3) {
          rateLimited = true;
          const delay = Number(res.headers.get('retry-after') || Math.pow(2, attempt + 1)) * 1000;
          console.warn(`Anthropic ${res.status} — retry in ${delay}ms (attempt ${attempt + 1})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        // Non-retriable error (400 billing/bad-request, 401 auth, etc.) — fail immediately
        lastErr = new Error(`Anthropic ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
        console.error('Anthropic non-retriable error:', lastErr.message);
        break;
      } catch (e) {
        lastErr = e;
        rateLimited = true; // network/timeout — worth trying Gemini
        if (attempt < 3) await new Promise(r => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
      }
    }
    // Only fall back to Gemini when Anthropic was rate-limited/overloaded/timed out
    // (not for billing/auth errors — those won't be fixed by switching provider)
    if (rateLimited && process.env.GEMINI_API_KEY) {
      try {
        console.warn('Anthropic rate-limited, falling back to Gemini:', lastErr?.message);
        return await callGemini(messages, systemPrompt);
      } catch (geminiErr) {
        console.error('Gemini fallback also failed:', geminiErr.message);
        throw geminiErr;
      }
    }
    throw lastErr || new Error('Anthropic API unavailable');
  }

  try {
    let turns = 0;
    while (submitted < TARGET && checksUsed < MAX_CHECKS && turns < 20) {
      turns++;
      const data = await callLLM(messages, systemPrompt);
      if (!data) throw new Error('No response from Anthropic API');

      messages.push({ role: 'assistant', content: data.content });

      if (data.stop_reason === 'end_turn') {
        if (submitted >= TARGET) break;
        // Claude stopped early — nudge it to continue, add budget note if burning checks fast
        const budgetNote = (checksUsed >= Math.floor(MAX_CHECKS * 0.5) && submitted < Math.floor(TARGET * 0.5))
          ? ` You are using checks faster than submissions. Switch to .io, .app, .ai, .co — .com is heavily registered for these concepts.`
          : '';
        messages.push({
          role: 'user',
          content: `You've submitted ${submitted} of ${TARGET} required domains. Please continue and find ${TARGET - submitted} more available domains.${budgetNote}`,
        });
        send({ type: 'searching', submitted, remaining: TARGET - submitted });
        continue;
      }

      if (data.stop_reason === 'tool_use') {
        const blocks = data.content.filter(b => b.type === 'tool_use');

        // ── Phase 1: quality gate (sequential — builds seenNames correctly) ──
        const pending = blocks.map(block => {
          if (block.name !== 'check_domain') return { block };

          const domain = String(block.input.domain || '').toLowerCase().trim();
          const tld    = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '';

          // Budget exhausted — return without a network call
          if (checksUsed >= MAX_CHECKS) {
            return { block, result: { available: false, reason: 'check budget exhausted — stop and summarise what you have found' } };
          }

          // Quality gate (free, no network)
          const gateErr = qualityGate(domain, seenNames, submittedNames);
          if (gateErr) {
            return { block, result: { available: false, reason: `quality: ${gateErr}` } };
          }

          // Passed — reserve a budget slot and mark as seen
          checksUsed++;
          seenNames.push(domain.slice(0, domain.lastIndexOf('.')));
          return { block, domain, tld, needsRdap: true };
        });

        // ── Phase 2: batch availability check for domains that passed quality gate ──
        // First resolve from cache; anything not cached goes to Namecheap batch (or RDAP fallback).
        const uncached = [];
        for (const p of pending) {
          if (!p.needsRdap) continue;
          const cached = await getCached(p.domain);
          if (cached !== null) {
            recordTld(p.tld, cached.available, ctx);
            p.result = cached.available
              ? { available: true,  reason: cached.premium ? `available (premium ~$${cached.price}/yr)` : 'available (cached)' }
              : { available: false, reason: 'taken (cached) — invent a completely new concept' };
            send({ type: 'check', domain: p.domain, available: cached.available === true });
          } else {
            uncached.push(p);
          }
        }

        if (uncached.length > 0) {
          const batchResults = await batchCheck(uncached.map(p => p.domain), clientIp);
          for (const p of uncached) {
            const r = batchResults[p.domain] ?? { available: null, premium: false, price: null };
            setCache(p.domain, r.available, r.premium ? r.price : null).catch(() => {});
            recordTld(p.tld, r.available, ctx);
            p.result = r.available === true
              ? { available: true,  reason: r.premium ? `available (premium ~$${r.price}/yr)` : 'available — call submit_domain now' }
              : r.available === false
              ? { available: false, reason: 'taken — invent a completely new concept, do not retry variations' }
              : { available: false, reason: 'inconclusive — treat as unavailable and try a different concept' };
            send({ type: 'check', domain: p.domain, available: r.available === true });
          }
        }

        // ── Phase 3: handle submit_domain + build tool results ───────────────
        const toolResults = [];
        for (const p of pending) {
          let result = p.result;

          if (p.block.name === 'submit_domain') {
            if (submitted < TARGET) {
              const domain = {
                name:       String(p.block.input.name      || '').toLowerCase().trim(),
                tld:        String(p.block.input.tld       || '').trim(),
                style:      ['brandable', 'keyword', 'hybrid'].includes(p.block.input.style)
                              ? p.block.input.style : 'brandable',
                rationale:  String(p.block.input.rationale || '').trim().slice(0, 120),
                confidence: Math.min(10, Math.max(1, parseInt(p.block.input.confidence) || 7)),
              };
              submittedNames.push(domain.name);
              submitted++;
              send({ type: 'domain', domain });
            }
            result = { accepted: true, submitted, remaining: TARGET - submitted };
          } else if (!result) {
            result = { error: 'unknown tool' };
          }

          toolResults.push({
            type:        'tool_result',
            tool_use_id: p.block.id,
            content:     JSON.stringify(result),
          });
        }

        // Track budget pressure for end_turn nudge
        if (!budgetWarned && checksUsed >= Math.floor(MAX_CHECKS * 0.5) && submitted < Math.floor(TARGET * 0.5)) {
          budgetWarned = true;
        }

        messages.push({ role: 'user', content: toolResults });
      }
    }

    // ── Increment usage after successful generation ────────────────────────────
    if (plan !== 'pro') {
      incrementUsage(userId).catch(e => console.error('CRITICAL: Usage increment failed — counter not updated:', e.message));
    }

    send({ type: 'done', count: submitted });

  } catch (err) {
    const msg = err.message || String(err);
    console.error('suggest.js error:', msg);
    const isRateLimit = /429|529|rate.limit|overload/i.test(msg);
    const isBilling  = /credit balance|billing|payment/i.test(msg);
    send({
      type: 'error',
      message: isBilling
        ? 'Service temporarily unavailable — please try again shortly.'
        : isRateLimit
          ? 'The AI service is busy right now — please try again in a few seconds.'
          : 'Failed to generate suggestions. Please try again.',
      detail: msg.slice(0, 200),
    });
  }

  res.end();
}
