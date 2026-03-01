export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { domains } = req.body;

  if (!Array.isArray(domains) || domains.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid domains array' });
  }

  const sanitised = domains
    .map(d => String(d).toLowerCase().trim())
    .filter(d => /^[a-z0-9][a-z0-9\-]*\.[a-z]{2,}$/.test(d))
    .slice(0, 20);

  if (sanitised.length === 0) {
    return res.status(400).json({ error: 'No valid domains provided' });
  }

  // ── Try Namecheap API first ────────────────────────────────────────────────
  const ncApiKey  = process.env.NAMECHEAP_API_KEY;
  const ncApiUser = process.env.NAMECHEAP_API_USER;

  if (ncApiKey && ncApiUser) {
    try {
      const clientIp =
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket?.remoteAddress ||
        '127.0.0.1';

      const domainList = sanitised.join(',');
      const ncUrl =
        `https://api.namecheap.com/xml.response` +
        `?ApiUser=${encodeURIComponent(ncApiUser)}` +
        `&ApiKey=${encodeURIComponent(ncApiKey)}` +
        `&UserName=${encodeURIComponent(ncApiUser)}` +
        `&Command=namecheap.domains.check` +
        `&ClientIp=${encodeURIComponent(clientIp)}` +
        `&DomainList=${encodeURIComponent(domainList)}`;

      const ncRes = await fetch(ncUrl, { signal: AbortSignal.timeout(15000) });
      const xml   = await ncRes.text();

      // Check for API error status
      if (xml.includes('Status="ERROR"') || xml.includes('ErrCount>0<')) {
        throw new Error('Namecheap API returned an error — falling back to RDAP');
      }

      // Parse <DomainCheckResult Domain="..." Available="true" IsPremiumName="true" PremiumRegistrationPrice="..." />
      const results = {};
      const premiumPrices = {};
      const regex = /DomainCheckResult([^>]+)/gi;
      let match;
      while ((match = regex.exec(xml)) !== null) {
        const attrs = match[1];
        const domain    = (attrs.match(/Domain="([^"]+)"/i)    || [])[1]?.toLowerCase();
        const available = (attrs.match(/Available="([^"]+)"/i) || [])[1]?.toLowerCase() === 'true';
        const isPremium = (attrs.match(/IsPremiumName="([^"]+)"/i) || [])[1]?.toLowerCase() === 'true';
        const premPrice = parseFloat((attrs.match(/PremiumRegistrationPrice="([^"]+)"/i) || [])[1] || '');
        if (domain) {
          results[domain] = available;
          if (isPremium && !isNaN(premPrice)) premiumPrices[domain] = premPrice;
        }
      }

      if (Object.keys(results).length > 0) {
        return res.status(200).json({ results, premiumPrices, source: 'namecheap' });
      }

      throw new Error('No results parsed from Namecheap XML — falling back to RDAP');
    } catch (err) {
      console.warn('Namecheap API failed, falling back to RDAP:', err.message);
    }
  }

  // ── RDAP fallback: check each domain in parallel ───────────────────────────
  async function rdapCheck(domain) {
    try {
      // Split into SLD + TLD so we can query the right RDAP bootstrap server
      const [sld, ...tldParts] = domain.split('.');
      const tld = tldParts.join('.');

      // RDAP bootstrap: IANA lists registrar RDAP servers per TLD
      const bootstrapRes = await fetch(
        `https://data.iana.org/rdap/dns.json`,
        { signal: AbortSignal.timeout(8000) }
      );
      const bootstrap = await bootstrapRes.json();

      // Find the RDAP base URL for this TLD
      let rdapBase = null;
      for (const [tlds, urls] of bootstrap.services) {
        if (tlds.includes(tld) && urls.length > 0) {
          rdapBase = urls[0].replace(/\/$/, '');
          break;
        }
      }

      if (!rdapBase) {
        // TLD not in RDAP bootstrap — treat as unknown
        return { domain, available: null };
      }

      const rdapRes = await fetch(
        `${rdapBase}/domain/${domain}`,
        { signal: AbortSignal.timeout(8000) }
      );

      if (rdapRes.status === 404) {
        // 404 means domain is NOT registered → available
        return { domain, available: true };
      }
      if (rdapRes.status === 200) {
        // 200 means domain IS registered → taken
        return { domain, available: false };
      }

      // Anything else (429, 5xx, etc.) → unknown
      return { domain, available: null };
    } catch {
      return { domain, available: null };
    }
  }

  const settled = await Promise.allSettled(sanitised.map(rdapCheck));

  const results = {};
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      const { domain, available } = outcome.value;
      results[domain] = available;
    }
  }

  return res.status(200).json({ results, source: 'rdap' });
}
