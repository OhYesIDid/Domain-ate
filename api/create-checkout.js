export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    const params = new URLSearchParams({
      mode:                        'subscription',
      'payment_method_types[]':    'card',
      'line_items[0][price]':      process.env.STRIPE_PRICE_ID,
      'line_items[0][quantity]':   '1',
      'success_url':               `https://domain-ate.com/demo.html?upgraded=true`,
      'cancel_url':                `https://domain-ate.com/demo.html`,
      'client_reference_id':       userId,
      'metadata[clerk_user_id]':   userId,
    });

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type':   'application/x-www-form-urlencoded',
      },
      body: params,
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) {
      console.error('Stripe error:', session);
      throw new Error(session.error?.message || 'Stripe checkout failed');
    }

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout.js error:', err);
    return res.status(500).json({ error: 'Could not create checkout session.' });
  }
}
