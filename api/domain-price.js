export const config = { maxDuration: 15 };

// Fallback prices (USD/yr) used when Namecheap API is unavailable
const FALLBACK_PRICES = {
  '.com':    8.88,
  '.net':   10.48,
  '.org':   11.06,
  '.io':    32.98,
  '.ai':    79.99,
  '.co':    29.98,
  '.app':   14.00,
  '.store': 19.98,
  '.xyz':   12.98,
  '.dev':   12.00,
  '.tech':  39.99,
  '.info':  14.98,
  '.me':    14.98,
  '.us':     8.98,
  '.uk':     9.98,
  '.online': 19.98,
  '.site':  19.98,
  '.shop':  29.98,
  '.biz':   14.98,
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  const { tlds } = req.body;
  if (!Array.isArray(tlds) || tlds.length === 0) {
    return res.status(400).json({ error: 'Missing tlds array' });
  }

  const apiUser = process.env.NAMECHEAP_API_USER;
  const apiKey  = process.env.NAMECHEAP_API_KEY;

  // Try Namecheap live pricing if credentials are set
  if (apiUser && apiKey) {
    try {
      const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || '0.0.0.0';
      const params = new URLSearchParams({
        ApiUser:         apiUser,
        ApiKey:          apiKey,
        UserName:        apiUser,
        ClientIp:        clientIp,
        Command:         'namecheap.users.getPricing',
        ProductType:     'DOMAIN',
        ActionName:      'REGISTER',
        ProductCategory: 'DOMAINS',
      });

      const ncRes = await fetch(`https://api.namecheap.com/xml.response?${params}`);
      const xml   = await ncRes.text();

      const prices = {};
      for (const tld of tlds) {
        const tldName = tld.replace(/^\./, ''); // e.g. 'com' from '.com'
        // Namecheap XML: <Product Name="com">...<Price Duration="1" DurationType="YEAR" Price="8.88" .../>
        const match = xml.match(
          new RegExp(`<Product Name="${tldName}"[^>]*>[\\s\\S]*?<Price[^>]*Duration="1"[^>]*DurationType="YEAR"[^>]*Price="([^"]+)"`, 'i')
        ) || xml.match(
          new RegExp(`<Product Name="${tldName}"[^>]*>[\\s\\S]*?<Price[^>]*Price="([^"]+)"[^>]*Duration="1"[^>]*DurationType="YEAR"`, 'i')
        );
        prices[tld] = match ? parseFloat(match[1]) : (FALLBACK_PRICES[tld] ?? null);
      }

      return res.status(200).json({ prices, source: 'namecheap' });
    } catch (err) {
      console.error('Namecheap pricing error, falling back:', err.message);
    }
  }

  // Fallback: return hardcoded prices
  const prices = {};
  for (const tld of tlds) {
    prices[tld] = FALLBACK_PRICES[tld] ?? null;
  }
  return res.status(200).json({ prices, source: 'fallback' });
}
