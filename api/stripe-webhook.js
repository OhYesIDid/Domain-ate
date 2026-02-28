import { createHmac } from 'crypto';

export const config = {
  maxDuration: 10,
  api: { bodyParser: false }, // Need raw body for Stripe signature verification
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyStripeSignature(payload, sigHeader, secret) {
  const parts     = sigHeader.split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const signature = parts.find(p => p.startsWith('v1='))?.slice(3);
  if (!timestamp || !signature) return false;

  const signed = `${timestamp}.${payload}`;
  const expected = createHmac('sha256', secret).update(signed).digest('hex');
  return expected === signature;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody  = await getRawBody(req);
  const sigHeader = req.headers['stripe-signature'];

  if (!verifyStripeSignature(rawBody.toString(), sigHeader, process.env.STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(rawBody.toString());

  // Handle subscription becoming active (new signup or reactivation)
  if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated'
  ) {
    const sub    = event.data.object;
    const userId = sub.metadata?.clerk_user_id;
    if (!userId) return res.status(200).json({ received: true });

    const plan = sub.status === 'active' ? 'pro' : 'free';

    await fetch(`https://api.clerk.com/v1/users/${userId}/metadata`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${process.env.CLERK_SECRET_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ public_metadata: { plan } }),
    });
  }

  // Handle subscription cancelled / expired
  if (event.type === 'customer.subscription.deleted') {
    const sub    = event.data.object;
    const userId = sub.metadata?.clerk_user_id;
    if (userId) {
      await fetch(`https://api.clerk.com/v1/users/${userId}/metadata`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.CLERK_SECRET_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ public_metadata: { plan: 'free' } }),
      });
    }
  }

  return res.status(200).json({ received: true });
}
