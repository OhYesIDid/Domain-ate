import { createPublicKey, verify } from 'crypto';

export const config = { maxDuration: 30 };

const FREE_LIMIT = 5;

// ── Clerk JWT verification ──────────────────────────────────────────────────

// Cache JWKS per issuer so we don't fetch on every request
const jwksCache = {};

async function getJwksForIssuer(iss) {
  const now = Date.now();
  if (jwksCache[iss] && now - jwksCache[iss].at < 3_600_000) {
    return jwksCache[iss].keys;
  }
  // Derive JWKS URL from the token's own issuer claim — no env var needed
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

    // Basic claim checks
    if (payload.exp * 1000 < Date.now()) return null;
    if (!payload.iss) return null;

    // Fetch the public keys from the token's own issuer
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
    return payload; // { sub: userId, publicMetadata: { plan } ... }
  } catch (err) {
    console.warn('verifyClerkToken error:', err.message);
    return null;
  }
}

// ── Upstash Redis helpers ───────────────────────────────────────────────────

function usageKey(userId) {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
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
  // Auto-expire after ~35 days so keys clean themselves up
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
    const usage = await getUsage(userId);
    if (usage >= FREE_LIMIT) {
      return res.status(402).json({
        error: `You've used all ${FREE_LIMIT} free consultations this month. Upgrade to Pro for unlimited access.`,
        usage,
        limit: FREE_LIMIT,
      });
    }
  }

  // ── Build prompt ────────────────────────────────────────────────────────
  const { description, answers } = req.body;
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid description' });
  }

  const geo      = answers?.geo      || 'global';
  const audience = answers?.audience || 'both';

  const geoLabel = {
    global: 'a global audience', us: 'the United States market',
    europe: 'the European market', asia: 'the Asia-Pacific market',
  }[geo] || 'a global audience';

  const audienceLabel = {
    b2b: 'businesses (B2B)', b2c: 'consumers (B2C)',
    genz: 'Gen Z / young consumers', both: 'a mixed audience',
  }[audience] || 'a mixed audience';

  const prompt = `You are a world-class domain name consultant. Generate exactly 10 creative domain name suggestions for the following business.

Business description: ${description}
Target geography: ${geoLabel}
Target audience: ${audienceLabel}

Requirements for each suggestion:
- The domain name must be 6–20 characters long (not counting the TLD)
- It must be memorable, easy to spell, and easy to say out loud
- Use a variety of TLDs: include at least 3 .com suggestions, and mix in .io, .app, .co, .xyz, .ai, .store, or other relevant TLDs
- Classify each as one of three styles: "brandable" (invented word, like Spotify), "keyword" (descriptive, like Booking.com), or "hybrid" (mix of both, like Pinterest)
- Provide a 1-line rationale (max 12 words) explaining why this name fits the business

You MUST respond with a valid JSON array and nothing else — no markdown, no explanation, no code fences. The array must contain exactly 10 objects in this format:

[
  {
    "name": "threadwise",
    "tld": ".com",
    "rationale": "Implies smart, curated fashion choices for modern buyers",
    "style": "brandable"
  }
]`;

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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
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
