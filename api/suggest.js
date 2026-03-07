import { createPublicKey, verify } from 'crypto';

export const config = { maxDuration: 60 };

const FREE_LIMIT    = 5;
const MAX_CHECKS    = 35;   // budget for check_domain tool calls
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

async function recordTld(tld, available) {
  const k = tld.replace(/\./g, '_');
  redisIncr(`tld:${k}:checked`).catch(() => {});
  if (available === true) redisIncr(`tld:${k}:avail`).catch(() => {});
}

async function getTldStats() {
  const tlds = ['.com', '.io', '.app', '.co', '.ai', '.dev'];
  const stats = {};
  try {
    const rows = await Promise.all(tlds.map(async tld => {
      const k = tld.replace(/\./g, '_');
      const [c, a] = await Promise.all([redisGet(`tld:${k}:checked`), redisGet(`tld:${k}:avail`)]);
      return { tld, checked: parseInt(c || '0'), avail: parseInt(a || '0') };
    }));
    for (const { tld, checked, avail } of rows) {
      if (checked >= 50) stats[tld] = Math.round((avail / checked) * 100);
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

// ── Quality gate ──────────────────────────────────────────────────────────────
// Called before RDAP — no network required.
// Returns null on pass, or a string describing why it failed.
// seenNames = names that already passed this gate (for diversity enforcement).

const PADDING_SUFFIXES = ['app', 'hq', 'get', 'now', 'go', 'try', 'my', 'use', 'hub', 'pro'];

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

function qualityGate(domain, seenNames) {
  const dot = domain.lastIndexOf('.');
  if (dot === -1) return 'missing TLD';
  const name = domain.slice(0, dot).toLowerCase();
  if (name.length < 5)  return 'too short (min 5 chars)';
  if (name.length > 12) return 'too long (max 12 chars)';
  if (/[0-9-]/.test(name)) return 'contains digits or hyphens';
  const vowelRatio = (name.match(/[aeiou]/gi) || []).length / name.length;
  if (vowelRatio < 0.2 || vowelRatio > 0.6) return 'poor vowel ratio — likely unpronounceable';
  if (/[^aeiou]{4,}/i.test(name))           return 'consonant cluster — unpronounceable';
  const offender = PADDING_SUFFIXES.find(p => name !== p && name.endsWith(p) && name.length > p.length + 2);
  if (offender) return `padding suffix detected — ends in "${offender}"`;
  for (const seen of seenNames) {
    if (editDist(name, seen) <= 2) return `too similar to already-tried "${seen}" — invent a different concept`;
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
        name:      { type: 'string', description: 'Domain name without TLD, lowercase' },
        tld:       { type: 'string', description: 'TLD including dot, e.g. ".io"' },
        style:     { type: 'string', enum: ['brandable', 'keyword', 'hybrid'] },
        rationale: { type: 'string', description: 'Why this name suits this specific business (max 15 words)' },
      },
      required: ['name', 'tld', 'style', 'rationale'],
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

  // ── Auth ─────────────────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sign in to generate domain suggestions.' });

  const payload = await verifyClerkToken(token);
  if (!payload)  return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });

  const userId = payload.sub;
  const plan   = payload.metadata?.plan || payload.publicMetadata?.plan || 'free';

  // ── Usage check (free plan, JSON response before SSE starts) ─────────────────
  if (plan !== 'pro') {
    try {
      const usage = await getUsage(userId);
      if (usage >= FREE_LIMIT) {
        return res.status(402).json({
          error: `You've used all ${FREE_LIMIT} free consultations this month. Upgrade to Pro for unlimited access.`,
          usage,
          limit: FREE_LIMIT,
        });
      }
    } catch (e) { console.warn('Usage check skipped:', e.message); }
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

  // ── TLD stats for dynamic prompt ──────────────────────────────────────────────
  const tldStats    = await getTldStats();
  const tldStatsStr = Object.keys(tldStats).length >= 3
    ? '\nLIVE AVAILABILITY DATA from recent searches:\n' +
      Object.entries(tldStats).map(([t, r]) => `${t}: ${r}% available`).join(' | ') +
      '\nWeight your TLD choices toward higher availability rates.\n'
    : '';

  // ── Build prompt ──────────────────────────────────────────────────────────────
  const geo      = answers?.geo      || 'global';
  const audience = answers?.audience || 'both';

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
    '• submit_domain — records a confirmed-available domain as a final suggestion\n\n' +
    `Your goal: submit exactly ${TARGET} confirmed-available domains.\n` +
    `Budget: at most ${MAX_CHECKS} check_domain calls — use them wisely.\n\n` +
    'CRITICAL RULE: When a domain is TAKEN, abandon that entire concept and invent something genuinely new. ' +
    'Never pad, never append, never retry with a single letter changed. ' +
    'The quality gate automatically rejects near-duplicates.';

  const geoLabel      = { global: 'Global (worldwide)', us: 'United States', europe: 'Europe', asia: 'Asia-Pacific' }[geo] || 'Global';
  const audienceLabel = { b2b: 'Businesses (B2B)', b2c: 'Consumers (B2C)', genz: 'Gen Z / young consumers', both: 'Mixed (B2B + B2C)' }[audience] || 'Mixed';

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
    `- 4 brandable (invented/abstract — like Spotify, Slack, Notion)\n` +
    `- 3 keyword (descriptive/literal — like Basecamp, Mailchimp)\n` +
    `- 3 hybrid (brand + keyword blend — like Pinterest, Dropbox)\n\n` +
    `NAMING REQUIREMENTS\n` +
    `- 5–12 characters (name only, excluding TLD)\n` +
    `- Memorable and easy to spell after hearing it once\n` +
    `- No hyphens, no numbers\n` +
    `- Each submission must come from a genuinely different creative concept\n\n` +
    `AVAILABILITY STRATEGY\n` +
    `Most obvious .com combinations are already registered. To find available names:\n` +
    `- Favour coined/invented words and unexpected combinations over common English word pairs\n` +
    `- For .com, include at least one non-dictionary element (blend, truncation, suffix like -ly/-ify/-io/-era/-ova)\n` +
    `- Freely use .io, .app, .co, .ai — these have far more availability than .com\n` +
    `- The more specific and creative the name, the more likely it is free\n\n` +
    `WORKFLOW\n` +
    `1. Think of a strong name concept suited to this business\n` +
    `2. Call check_domain — inspect the result carefully\n` +
    `3. If available → immediately call submit_domain\n` +
    `4. If taken or rejected → invent a completely different concept, do not retry variations\n` +
    `5. Repeat until you have submitted ${TARGET} domains`;

  // ── Agentic tool-use loop ─────────────────────────────────────────────────────
  const messages  = [{ role: 'user', content: userMessage }];
  let checksUsed  = 0;
  let submitted   = 0;
  const seenNames = []; // names that passed quality gate — used for diversity enforcement

  try {
    let turns = 0;
    while (submitted < TARGET && checksUsed < MAX_CHECKS && turns < 20) {
      turns++;
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 4096,
          system:     systemPrompt,
          tools:      TOOLS,
          messages,
        }),
      });

      const data = await claudeRes.json();
      if (!claudeRes.ok) throw new Error(`Anthropic API: ${claudeRes.status} ${JSON.stringify(data)}`);

      messages.push({ role: 'assistant', content: data.content });

      if (data.stop_reason === 'end_turn') {
        if (submitted >= TARGET) break;
        // Claude stopped early — nudge it to continue
        messages.push({
          role: 'user',
          content: `You've submitted ${submitted} of ${TARGET} required domains. Please continue and find ${TARGET - submitted} more available domains.`,
        });
        continue;
      }

      if (data.stop_reason === 'tool_use') {
        const blocks      = data.content.filter(b => b.type === 'tool_use');
        const toolResults = [];

        // Sequential execution keeps the seenNames diversity list consistent
        for (const block of blocks) {
          let result;

          // ── check_domain ────────────────────────────────────────────────────
          if (block.name === 'check_domain') {
            checksUsed++;
            const domain = String(block.input.domain || '').toLowerCase().trim();
            const tld    = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '';

            // 1. Quality gate (no network)
            const gateErr = qualityGate(domain, seenNames);
            if (gateErr) {
              result = { available: false, reason: `quality: ${gateErr}` };
            } else {
              // Mark name as seen so near-duplicates fail diversity check
              seenNames.push(domain.slice(0, domain.lastIndexOf('.')));

              // 2. Cache lookup (cross-user, accumulated over time)
              const cached = await getCached(domain);
              if (cached !== null) {
                recordTld(tld, cached.available);
                result = cached.available
                  ? { available: true,  reason: cached.premium ? `available (premium ~$${cached.price}/yr)` : 'available (cached)' }
                  : { available: false, reason: 'taken (cached) — invent a completely new concept' };
              } else {
                // 3. Live RDAP check
                const available = await rdapCheck(domain);
                setCache(domain, available).catch(() => {});
                recordTld(tld, available);
                result = available === true
                  ? { available: true,  reason: 'available — call submit_domain now' }
                  : available === false
                  ? { available: false, reason: 'taken — invent a completely new concept, do not retry variations' }
                  : { available: false, reason: 'inconclusive — treat as unavailable and try a different concept' };
              }
            }

          // ── submit_domain ───────────────────────────────────────────────────
          } else if (block.name === 'submit_domain') {
            if (submitted < TARGET) {
              const domain = {
                name:      String(block.input.name      || '').toLowerCase().trim(),
                tld:       String(block.input.tld       || '').trim(),
                style:     ['brandable', 'keyword', 'hybrid'].includes(block.input.style)
                             ? block.input.style : 'brandable',
                rationale: String(block.input.rationale || '').trim().slice(0, 120),
              };
              submitted++;
              send({ type: 'domain', domain });
            }
            result = { accepted: true, submitted, remaining: TARGET - submitted };

          } else {
            result = { error: 'unknown tool' };
          }

          toolResults.push({
            type:        'tool_result',
            tool_use_id: block.id,
            content:     JSON.stringify(result),
          });
        }

        messages.push({ role: 'user', content: toolResults });
      }
    }

    // ── Increment usage after successful generation ────────────────────────────
    if (plan !== 'pro') {
      incrementUsage(userId).catch(e => console.warn('Usage increment failed:', e.message));
    }

    send({ type: 'done', count: submitted });

  } catch (err) {
    console.error('suggest.js error:', err);
    send({ type: 'error', message: 'Failed to generate suggestions. Please try again.' });
  }

  res.end();
}
