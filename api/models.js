export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey = process.env.ANTHROPIC_API_KEY;

  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });

    const data = await response.json();
    console.log('Models response:', response.status, JSON.stringify(data));
    return res.status(response.status).json(data);
  } catch (error) {
    console.error('models.js error:', error);
    return res.status(500).json({ error: error.message });
  }
}
