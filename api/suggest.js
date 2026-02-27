export const config = { maxDuration: 30 };

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { description, answers } = req.body;

  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid description' });
  }

  const geo = answers?.geo || 'global';
  const audience = answers?.audience || 'both';

  const geoLabel = {
    global: 'a global audience',
    us: 'the United States market',
    europe: 'the European market',
    asia: 'the Asia-Pacific market',
  }[geo] || 'a global audience';

  const audienceLabel = {
    b2b: 'businesses (B2B)',
    b2c: 'consumers (B2C)',
    genz: 'Gen Z / young consumers',
    both: 'a mixed audience',
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

  try {
    const message = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = message.content[0].text.trim();

    let suggestions;
    try {
      suggestions = JSON.parse(rawText);
    } catch {
      const match = rawText.match(/\[[\s\S]*\]/);
      if (match) {
        suggestions = JSON.parse(match[0]);
      } else {
        throw new Error('Could not parse Claude response as JSON');
      }
    }

    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      throw new Error('Invalid suggestions format from Claude');
    }

    suggestions = suggestions.slice(0, 10).map(s => ({
      name: String(s.name || '').toLowerCase().trim(),
      tld: String(s.tld || '.com').trim(),
      rationale: String(s.rationale || '').trim(),
      style: ['brandable', 'keyword', 'hybrid'].includes(s.style) ? s.style : 'brandable',
    }));

    return res.status(200).json({ suggestions });
  } catch (error) {
    console.error('suggest.js error:', error);
    return res.status(500).json({ error: 'Failed to generate suggestions. Please try again.' });
  }
}
