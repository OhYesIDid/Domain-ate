export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { domain } = req.query;
  if (!domain || typeof domain !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    return res.status(400).json({ error: 'Invalid domain' });
  }

  try {
    const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&limit=1&fl=timestamp,statuscode&filter=statuscode:200`;
    const r   = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    // data is [] (no results) or [["timestamp","statuscode"], ["20190312...", "200"]]
    const hasHistory = Array.isArray(data) && data.length > 1;
    const year       = hasHistory ? String(data[1][0]).slice(0, 4) : null;
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.json({ hasHistory, year });
  } catch (err) {
    // Treat network errors as "no history" so cards aren't broken
    return res.json({ hasHistory: false, year: null });
  }
}
