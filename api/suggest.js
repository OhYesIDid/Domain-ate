import { createPublicKey, verify } from 'crypto';

export const config = { maxDuration: 30 };

const FREE_LIMIT = 5;

// ── Clerk JWT verification ──────────────────────────────────────────────────

const jwksCache = {};

async function getJwksForIssuer(iss) {
  const now = Date.now();
  if (jwksCache[iss] && now - jwksCache[iss].at < 3_600_000) {
    return jwksCache[iss].keys;
  }
  const jwksUrl = `${iss}/.well-known/jwks.json`;
  const res = await fetch(jwksUrl);
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
    if (!valid) return null;
    return payload;
  } catch (err) {
    console.warn('verifyClerkToken error:', err.message);
    return null;
  }
}

// ── Upstash Redis helpers ───────────────────────────────────────────────────

function usageKey(userId) {
  const month = new Date().toISOString().slice(0, 7);
  return `usage:${userId}:${month}`;
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
  await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/incr/${key}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
  await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/expire/${key}/3024000`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
}

// ── Main handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // ── Auth check ──────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'Sign in to generate domain suggestions.' });

  const payload = await verifyClerkToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });

  const userId = payload.sub;
  const plan   = payload.metadata?.plan || payload.publicMetadata?.plan || 'free';

  // ── Usage check (free plan only) ────────────────────────────────────────
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
    } catch (usageErr) {
      console.warn('Usage check skipped (Upstash not configured?):', usageErr.message);
    }
  }

  // ── Build prompt ────────────────────────────────────────────────────────
  const { description, answers } = req.body;
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid description' });
  }

  const geo      = answers?.geo      || 'global';
  const audience = answers?.audience || 'both';

  // Geo → explicit TLD rules
  const tldRules = {
    global:
      'Include at least 4 .com suggestions — they carry universal trust. ' +
      'The remaining 6 can use .io, .app, .co, .ai, or .co — choose whichever best fits each name.',
    us:
      'Include at least 5 .com suggestions — US audiences strongly equate .com with credibility. ' +
      'The remaining 5 can use .io, .app, or .co.',
    europe:
      'Include at least 3 .com suggestions for global reach. ' +
      'You may also suggest .eu or .co.uk options to signal European presence. ' +
      'Remaining slots can use .io, .app, or .co.',
    asia:
      'Include at least 3 .com suggestions — still the most trusted TLD in Asia-Pacific. ' +
      'You may also suggest .asia or .co for regional relevance. ' +
      'Remaining slots can use .io or .app.',
  }[geo] || 'Include at least 4 .com suggestions. Remaining can use .io, .app, .co, or .ai.';

  // Audience → explicit tone and style rules
  const audienceTone = {
    b2b:
      'Tone: professional and authoritative. Names must convey reliability, expertise, and trustworthiness. ' +
      'Avoid slang, playful misspellings, juvenile abbreviations, or anything that sounds casual or consumer-facing.',
    b2c:
      'Tone: energetic and approachable. Emotional and lifestyle-oriented names work well. ' +
      'Colloquial language is acceptable. Focus on how the name makes a customer feel.',
    genz:
      'Tone: internet-native and bold. Embrace neologisms, unexpected spellings, abbreviations, and ironic or playful language. ' +
      'Avoid corporate-sounding, formal, or overly polished names. Irreverent works well.',
    both:
      'Tone: balance professionalism with approachability. ' +
      'Names must feel credible in a formal pitch deck AND welcoming on a consumer-facing homepage.',
  }[audience] || 'Tone: balance professionalism with approachability.';

  // ── System prompt: persona only ─────────────────────────────────────────
  const systemPrompt =
    'You are a world-class domain name consultant with 15 years of experience ' +
    'helping startups and established businesses secure memorable, brandable domain names. ' +
    'You understand linguistics, brand psychology, and how domain choices affect conversion and recall. ' +
    'You only ever respond with raw JSON — never markdown, code fences, or any surrounding text.';

  // ── User message: task + rules + data ──────────────────────────────────
  const userMessage = `Generate exactly 10 domain name suggestions for this business.

BUSINESS DETAILS
Description: ${description}
Target market: ${({ global: 'Global (worldwide)', us: 'United States', europe: 'Europe', asia: 'Asia-Pacific' })[geo] || 'Global'}
Target audience: ${({ b2b: 'Businesses (B2B)', b2c: 'Consumers (B2C)', genz: 'Gen Z / young consumers', both: 'Mixed (B2B + B2C)' })[audience] || 'Mixed'}

AUDIENCE TONE
${audienceTone}

TLD RULES FOR THIS MARKET
${tldRules}

STYLE DISTRIBUTION (must be exact)
Return exactly:
- 4 brandable suggestions (invented or abstract words — like Spotify, Slack, Notion)
- 3 keyword suggestions (descriptive, literal meaning — like Basecamp, Booking.com, Mailchimp)
- 3 hybrid suggestions (blend of brand + keyword — like Pinterest, Dropbox, YouTube)

NAMING REQUIREMENTS
- 6–20 characters (not counting the TLD)
- Memorable and easy to spell after hearing it spoken once
- One obvious way to write it — no ambiguous spellings
- No hyphens, no numbers

AVAILABILITY AWARENESS
Most obvious .com combinations are already registered. To maximise the chance of names actually being available:
- Favour invented/coined words and unexpected combinations over common English word pairs
- For .com names, use at least one non-dictionary element (a blend, a truncation, or a suffix like -ly, -ify, -io, -era, -ova)
- Freely use .io, .app, .co, .ai TLDs where they suit the brand — these have far more availability than .com
- The more creative and specific to this exact business, the more likely the domain is free

AVOID (exclude any name that matches these)
- Generic pairings of two common words (e.g. "QuickShop", "BestTools", "FastBuy")
- Double letters that create spelling confusion (e.g. "toolly", "apppe")
- Names that closely resemble an existing well-known brand or product
- Names that require cultural or linguistic knowledge to pronounce correctly

QUALITY CHECK — apply before including each name
1. Could a native English speaker spell this correctly after hearing it once?
2. Does it clearly avoid sounding like an existing major brand?
3. Is the rationale specific to THIS business — not generic praise like "catchy" or "memorable"?
Remove any name that fails any of the three checks.

EXAMPLES OF THE REQUIRED FORMAT
[
  { "name": "threadwise", "tld": ".com", "style": "brandable", "rationale": "Implies curated fashion intelligence for trend-aware modern buyers" },
  { "name": "fastbooking", "tld": ".io", "style": "keyword", "rationale": "Direct, action-driven name built for a B2B scheduling platform" },
  { "name": "snaplaunch", "tld": ".app", "style": "hybrid", "rationale": "Conveys speed and simplicity for a product launch management tool" }
]

Respond with a valid JSON array of exactly 10 objects. Each object must have: name (string), tld (string starting with .), style (brandable | keyword | hybrid), rationale (max 15 words). No other text.`;

  // ── Call Anthropic ──────────────────────────────────────────────────────
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Anthropic API error:', response.status, JSON.stringify(data));
      throw new Error(`Anthropic API returned ${response.status}`);
    }

    const rawText = data.content[0].text.trim();
    let suggestions;
    try {
      suggestions = JSON.parse(rawText);
    } catch {
      const match = rawText.match(/\[[\s\S]*\]/);
      if (match) suggestions = JSON.parse(match[0]);
      else throw new Error('Could not parse Claude response as JSON');
    }

    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      throw new Error('Invalid suggestions format from Claude');
    }

    suggestions = suggestions.slice(0, 10).map(s => ({
      name:      String(s.name      || '').toLowerCase().trim(),
      tld:       String(s.tld       || '.com').trim(),
      rationale: String(s.rationale || '').trim(),
      style:     ['brandable', 'keyword', 'hybrid'].includes(s.style) ? s.style : 'brandable',
    }));

    // ── Increment usage (after successful generation) ──────────────────
    if (plan !== 'pro') {
      await incrementUsage(userId).catch(err =>
        console.warn('Usage increment failed (non-fatal):', err.message)
      );
    }

    return res.status(200).json({ suggestions });
  } catch (error) {
    console.error('suggest.js error:', error);
    return res.status(500).json({ error: 'Failed to generate suggestions. Please try again.' });
  }
}
