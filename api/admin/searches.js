export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) return res.status(503).json({ error: 'ADMIN_SECRET not configured' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token !== adminSecret) return res.status(401).json({ error: 'Unauthorized' });

  const auth  = { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` };
  const base  = process.env.UPSTASH_REDIS_REST_URL;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const page  = Math.max(0, parseInt(req.query.page || '0', 10));
  const start = page * limit;
  const stop  = start + limit - 1;

  try {
    const [rangeRes, cardRes] = await Promise.all([
      fetch(`${base}/zrevrange/searches:all/${start}/${stop}`, { headers: auth }),
      fetch(`${base}/zcard/searches:all`, { headers: auth }),
    ]);

    const [rangeData, cardData] = await Promise.all([rangeRes.json(), cardRes.json()]);
    const ids   = rangeData.result || [];
    const total = cardData.result  || 0;

    const searches = ids.length === 0 ? [] : await Promise.all(
      ids.map(async id => {
        const r = await fetch(`${base}/get/${encodeURIComponent(`search:${id}`)}`, { headers: auth });
        const d = await r.json();
        try { return JSON.parse(d.result); } catch { return null; }
      })
    );

    res.setHeader('Cache-Control', 'no-store');
    return res.json({ searches: searches.filter(Boolean), total, page, limit });
  } catch (err) {
    console.error('admin/searches error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch search logs' });
  }
}
