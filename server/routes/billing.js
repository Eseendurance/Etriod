const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { captureException } = require('../errorTracking');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const stripe = () => process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const configured = provider => {
  if (provider === 'stripe') return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_TEAM_PRICE_ID);
  if (provider === 'flutterwave') return !!(process.env.FLUTTERWAVE_SECRET_KEY && process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH &&
    process.env.FLUTTERWAVE_TEAM_PLAN_ID && Number(process.env.FLUTTERWAVE_TEAM_AMOUNT) > 0);
  if (provider === 'paystack') return !!(process.env.PAYSTACK_SECRET_KEY && process.env.PAYSTACK_TEAM_PLAN_CODE &&
    Number(process.env.PAYSTACK_TEAM_AMOUNT) > 0);
  return false;
};
const appUrl = () => (process.env.APP_URL || 'http://localhost:5500').replace(/\/+$/, '');
const paymentAmount = provider => Number(
  provider === 'flutterwave' ? process.env.FLUTTERWAVE_TEAM_AMOUNT : process.env.PAYSTACK_TEAM_AMOUNT
);
const paymentCurrency = provider => provider === 'flutterwave'
  ? (process.env.FLUTTERWAVE_CURRENCY || 'NGN')
  : (process.env.PAYSTACK_CURRENCY || 'NGN');
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

async function createPaymentOrder(userId, provider, reference) {
  const amount = paymentAmount(provider);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Set a valid ${provider.toUpperCase()} Team amount before enabling checkout.`);
  await pool.query(
    `INSERT INTO payment_orders (id, user_id, payment_provider, provider_reference, expected_amount, currency)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [crypto.randomUUID(), userId, provider, reference, amount, paymentCurrency(provider)]
  );
}

async function saveSubscription({ userId, provider, providerSubscriptionId, providerCustomerId, stripeId, status, currentPeriodEnd }) {
  if (!userId || !providerSubscriptionId) throw new Error('Verified payment did not include a subscription reference.');
  await pool.query(
    `INSERT INTO subscriptions
       (id, user_id, stripe_subscription_id, payment_provider, provider_subscription_id, provider_customer_id, plan, status, current_period_end)
     VALUES ($1, $2, $3, $4, $5, $6, 'team', $7, $8)
     ON CONFLICT (payment_provider, provider_subscription_id)
     DO UPDATE SET status = EXCLUDED.status,
                   provider_customer_id = EXCLUDED.provider_customer_id,
                   current_period_end = EXCLUDED.current_period_end`,
    [crypto.randomUUID(), userId, stripeId || null, provider, providerSubscriptionId, providerCustomerId || null, status, currentPeriodEnd || null]
  );
  if (status === 'active' || status === 'trialing') {
    await pool.query(`UPDATE users SET plan = 'team' WHERE id = $1`, [userId]);
  } else {
    await pool.query(
      `UPDATE users SET plan = CASE WHEN EXISTS (
         SELECT 1 FROM subscriptions WHERE user_id = $1 AND plan = 'team' AND status IN ('active','trialing')
       ) THEN 'team' ELSE 'personal' END WHERE id = $1`,
      [userId]
    );
  }
}

router.get('/config', (req, res) => {
  res.json({
    providers: ['stripe', 'flutterwave', 'paystack']
      .filter(configured)
      .map(provider => ({
        id: provider,
        name: provider === 'stripe' ? 'Stripe' : provider === 'flutterwave' ? 'Flutterwave' : 'Paystack',
        currency: provider === 'stripe' ? (process.env.STRIPE_DISPLAY_CURRENCY || 'USD') :
          provider === 'flutterwave' ? (process.env.FLUTTERWAVE_CURRENCY || 'NGN') :
            (process.env.PAYSTACK_CURRENCY || 'NGN'),
        amount: provider === 'stripe' ? (process.env.STRIPE_DISPLAY_AMOUNT || '') :
          provider === 'flutterwave' ? process.env.FLUTTERWAVE_TEAM_AMOUNT :
            process.env.PAYSTACK_TEAM_AMOUNT
      }))
  });
});

router.get('/status', requireAuth, async (req, res) => {
  try {
    const [userResult, result] = await Promise.all([
      pool.query('SELECT plan FROM users WHERE id = $1', [req.user.id]),
      pool.query(
        `SELECT payment_provider, plan, status, current_period_end, created_at
         FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [req.user.id]
      )
    ]);
    res.json({ plan: userResult.rows[0]?.plan || 'personal', subscriptions: result.rows });
  } catch (err) {
    console.error('[billing/status]', err);
    res.status(500).json({ error: 'Could not load billing status.' });
  }
});

router.post('/checkout', requireAuth, async (req, res) => {
  const provider = String(req.body?.provider || 'stripe').toLowerCase();
  if (!['stripe', 'flutterwave', 'paystack'].includes(provider)) {
    return res.status(400).json({ error: 'Choose Stripe, Flutterwave, or Paystack.' });
  }
  if (!configured(provider)) {
    return res.status(503).json({ error: `${provider} is not configured for the Team plan on this server.` });
  }
  try {
    const userResult = await pool.query('SELECT id, email, name, stripe_customer_id FROM users WHERE id = $1', [req.user.id]);
    if (!userResult.rows.length) return res.status(404).json({ error: 'Account not found.' });
    const activePlan = await pool.query(
      `SELECT 1 FROM subscriptions
       WHERE user_id = $1 AND plan = 'team' AND status IN ('active','trialing')
       LIMIT 1`,
      [req.user.id]
    );
    if (activePlan.rows.length) return res.status(409).json({ error: 'Your account already has an active Team subscription.' });
    const user = userResult.rows[0];
    const callbackUrl = `${appUrl()}/pricing.html?billing=return`;
    let url;

    if (provider === 'stripe') {
      const client = stripe();
      let customerId = user.stripe_customer_id;
      if (!customerId) {
        const customer = await client.customers.create({ email: user.email, name: user.name });
        customerId = customer.id;
        await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, user.id]);
      }
      const session = await client.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: process.env.STRIPE_TEAM_PRICE_ID, quantity: 1 }],
        success_url: `${callbackUrl}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl()}/pricing.html?billing=cancelled`,
        client_reference_id: user.id,
        metadata: { userId: user.id, plan: 'team' },
        subscription_data: { metadata: { userId: user.id, plan: 'team' } }
      });
      url = session.url;
    } else if (provider === 'flutterwave') {
      const reference = `etriod-${user.id}-${crypto.randomUUID()}`;
      await createPaymentOrder(user.id, provider, reference);
      const response = await fetch('https://api.flutterwave.com/v3/payments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tx_ref: reference,
          amount: process.env.FLUTTERWAVE_TEAM_AMOUNT,
          currency: process.env.FLUTTERWAVE_CURRENCY || 'NGN',
          redirect_url: callbackUrl,
          payment_options: 'card',
          payment_plan: process.env.FLUTTERWAVE_TEAM_PLAN_ID,
          customer: { email: user.email, name: user.name },
          meta: { userId: user.id, plan: 'team' },
          customizations: { title: 'Etriod Team', description: 'Monthly Team subscription' }
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.status !== 'success' || !result.data?.link) {
        console.error('[billing/flutterwave-checkout]', response.status, result);
        throw new Error('Flutterwave could not start checkout. Check the plan, amount, and currency configuration.');
      }
      url = result.data.link;
    } else {
      const reference = `etriod-${user.id}-${crypto.randomUUID()}`;
      await createPaymentOrder(user.id, provider, reference);
      const response = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user.email,
          amount: String(Math.round(Number(process.env.PAYSTACK_TEAM_AMOUNT) * 100)),
          currency: process.env.PAYSTACK_CURRENCY || 'NGN',
          plan: process.env.PAYSTACK_TEAM_PLAN_CODE,
          reference,
          callback_url: callbackUrl,
          metadata: { userId: user.id, plan: 'team' }
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.status !== true || !result.data?.authorization_url) {
        console.error('[billing/paystack-checkout]', response.status, result);
        throw new Error('Paystack could not start checkout. Check the plan, amount, and currency configuration.');
      }
      url = result.data.authorization_url;
    }
    res.json({ url });
  } catch (err) {
    console.error(`[billing/${provider}-checkout]`, err);
    res.status(502).json({ error: err.message || 'Could not start checkout.' });
  }
});

async function stripeWebhookHandler(req, res) {
  const client = stripe();
  if (!client || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe billing is not configured.');
  let event;
  try {
    event = client.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[billing/stripe-webhook] signature verification failed', err.message);
    return res.status(400).send('Webhook signature verification failed.');
  }
  try {
    if (['customer.subscription.updated', 'customer.subscription.created', 'customer.subscription.deleted'].includes(event.type)) {
      const sub = event.data.object;
      const userResult = await pool.query('SELECT id FROM users WHERE stripe_customer_id = $1', [sub.customer]);
      if (userResult.rows.length) {
        await saveSubscription({
          userId: userResult.rows[0].id,
          provider: 'stripe',
          providerSubscriptionId: sub.id,
          stripeId: sub.id,
          providerCustomerId: sub.customer,
          status: sub.status === 'canceled' || event.type.endsWith('.deleted') ? 'canceled' : sub.status,
          currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null
        });
      }
    } else if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.mode === 'subscription' && session.subscription && session.metadata?.userId) {
        const sub = await client.subscriptions.retrieve(session.subscription);
        await saveSubscription({
          userId: session.metadata.userId,
          provider: 'stripe',
          providerSubscriptionId: sub.id,
          stripeId: sub.id,
          providerCustomerId: session.customer,
          status: sub.status,
          currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null
        });
      }
    }
    res.json({ received: true });
  } catch (err) {
    captureException(err, { route: 'billing/stripe-webhook', eventType: event.type });
    res.status(500).send('Webhook handling failed.');
  }
}

async function flutterwaveWebhookHandler(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH || !safeEqual(req.headers['verif-hash'], process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH)) {
    return res.status(401).send('Invalid webhook signature.');
  }
  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).send('Invalid webhook payload.'); }
  if (event.event !== 'charge.completed' || event.data?.status !== 'successful') {
    const lifecycle = {
      'subscription.created': 'active',
      'subscription.activated': 'active',
      'subscription.cancelled': 'canceled',
      'subscription.deactivated': 'canceled'
    }[event.event];
    if (!lifecycle) return res.json({ received: true });
    try {
      const subscriptionId = String(event.data?.id || event.data?.subscription_id || '');
      if (!subscriptionId) return res.status(400).send('Subscription reference is missing.');
      const updated = await pool.query(
        `UPDATE subscriptions SET status = $1
         WHERE payment_provider = 'flutterwave' AND provider_subscription_id = $2
         RETURNING user_id`,
        [lifecycle, subscriptionId]
      );
      for (const row of updated.rows) {
        await pool.query(
          `UPDATE users SET plan = CASE WHEN EXISTS (
             SELECT 1 FROM subscriptions WHERE user_id = $1 AND plan = 'team' AND status IN ('active','trialing')
           ) THEN 'team' ELSE 'personal' END WHERE id = $1`,
          [row.user_id]
        );
      }
      return res.json({ received: true });
    } catch (err) {
      captureException(err, { route: 'billing/flutterwave-subscription-webhook' });
      return res.status(500).send('Webhook handling failed.');
    }
  }
  try {
    const verify = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(event.data.id)}/verify`, {
      headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` }
    });
    const result = await verify.json().catch(() => ({}));
    const tx = result.data;
    const orderResult = tx?.tx_ref ? await pool.query(
      `SELECT id, user_id, expected_amount, currency, status FROM payment_orders
       WHERE payment_provider = 'flutterwave' AND provider_reference = $1`,
      [tx.tx_ref]
    ) : { rows: [] };
    const order = orderResult.rows[0];
    if (!verify.ok || result.status !== 'success' || tx?.status !== 'successful' ||
      tx.tx_ref !== event.data.tx_ref || tx.currency !== (process.env.FLUTTERWAVE_CURRENCY || 'NGN') ||
      Number(tx.amount) < Number(process.env.FLUTTERWAVE_TEAM_AMOUNT)) {
      return res.status(400).send('Payment verification failed.');
    }
    if (order) {
      if (order.status === 'paid') return res.json({ received: true });
      if (order.status !== 'pending' || tx.currency !== order.currency ||
        Number(tx.amount) < Number(order.expected_amount) || tx.meta?.plan !== 'team') {
        return res.status(400).send('Payment verification failed.');
      }
      await saveSubscription({
        userId: order.user_id,
        provider: 'flutterwave',
        providerSubscriptionId: String(tx.subscription_id || tx.tx_ref),
        providerCustomerId: tx.customer?.id ? String(tx.customer.id) : null,
        status: 'active',
        currentPeriodEnd: null
      });
      await pool.query(`UPDATE payment_orders SET status = 'paid' WHERE id = $1 AND status = 'pending'`, [order.id]);
    } else if (tx.subscription_id) {
      const updated = await pool.query(
        `UPDATE subscriptions SET status = 'active'
         WHERE payment_provider = 'flutterwave' AND provider_subscription_id = $1
         RETURNING user_id`,
        [String(tx.subscription_id)]
      );
      if (!updated.rows.length) return res.status(400).send('Payment is not associated with an active subscription.');
    } else {
      return res.status(400).send('Payment order was not found.');
    }
    res.json({ received: true });
  } catch (err) {
    captureException(err, { route: 'billing/flutterwave-webhook' });
    res.status(500).send('Webhook handling failed.');
  }
}

async function paystackWebhookHandler(req, res) {
  const signature = req.headers['x-paystack-signature'];
  const expected = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY || '').update(req.body).digest('hex');
  if (!process.env.PAYSTACK_SECRET_KEY || !safeEqual(signature, expected)) return res.status(401).send('Invalid webhook signature.');
  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send('Invalid webhook payload.'); }
  if (event.event !== 'charge.success') {
    const lifecycle = {
      'subscription.create': 'active',
      'subscription.enable': 'active',
      'subscription.disable': 'canceled',
      'subscription.not_renew': 'canceled'
    }[event.event];
    if (!lifecycle) return res.json({ received: true });
    try {
      const subscriptionId = event.data?.subscription_code;
      if (!subscriptionId) return res.status(400).send('Subscription reference is missing.');
      const updated = await pool.query(
        `UPDATE subscriptions SET status = $1,
           current_period_end = CASE WHEN $1 = 'canceled' THEN now() ELSE current_period_end END
         WHERE payment_provider = 'paystack' AND provider_subscription_id = $2
         RETURNING user_id`,
        [lifecycle, subscriptionId]
      );
      for (const row of updated.rows) {
        await pool.query(
          `UPDATE users SET plan = CASE WHEN EXISTS (
             SELECT 1 FROM subscriptions WHERE user_id = $1 AND plan = 'team' AND status IN ('active','trialing')
           ) THEN 'team' ELSE 'personal' END WHERE id = $1`,
          [row.user_id]
        );
      }
      return res.json({ received: true });
    } catch (err) {
      captureException(err, { route: 'billing/paystack-subscription-webhook' });
      return res.status(500).send('Webhook handling failed.');
    }
  }
  const reference = event.data?.reference;
  if (!reference) return res.status(400).send('Payment reference is missing.');
  try {
    const verify = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const result = await verify.json().catch(() => ({}));
    const tx = result.data;
    const orderResult = await pool.query(
      `SELECT id, user_id, expected_amount, currency, status FROM payment_orders
       WHERE payment_provider = 'paystack' AND provider_reference = $1`,
      [reference]
    );
    const order = orderResult.rows[0];
    const expectedAmount = order ? Math.round(Number(order.expected_amount) * 100) : -1;
    if (!verify.ok || result.status !== true || tx?.status !== 'success' ||
      tx.reference !== reference || tx.currency !== (process.env.PAYSTACK_CURRENCY || 'NGN') ||
      Number(tx.amount) < Math.round(Number(process.env.PAYSTACK_TEAM_AMOUNT) * 100)) {
      return res.status(400).send('Payment verification failed.');
    }
    if (!order) {
      const subscriptionId = tx.subscription?.subscription_code;
      if (!subscriptionId) return res.status(400).send('Payment order was not found.');
      const updated = await pool.query(
        `UPDATE subscriptions SET status = 'active'
         WHERE payment_provider = 'paystack' AND provider_subscription_id = $1
         RETURNING user_id`,
        [subscriptionId]
      );
      if (!updated.rows.length) return res.status(400).send('Payment is not associated with an active subscription.');
      return res.json({ received: true });
    }
    if (order.status === 'paid') return res.json({ received: true });
    if (order.status !== 'pending' || tx.currency !== order.currency ||
      Number(tx.amount) < expectedAmount || tx.metadata?.plan !== 'team') {
      return res.status(400).send('Payment verification failed.');
    }
    const sub = tx.plan_object || tx.subscription;
    await saveSubscription({
      userId: order.user_id,
      provider: 'paystack',
      providerSubscriptionId: sub?.subscription_code || reference,
      providerCustomerId: tx.customer?.customer_code || null,
      status: 'active',
      currentPeriodEnd: sub?.next_payment_date ? new Date(sub.next_payment_date) : null
    });
    await pool.query(`UPDATE payment_orders SET status = 'paid' WHERE id = $1 AND status = 'pending'`, [order.id]);
    res.json({ received: true });
  } catch (err) {
    captureException(err, { route: 'billing/paystack-webhook' });
    res.status(500).send('Webhook handling failed.');
  }
}

module.exports = router;
module.exports.stripeWebhookHandler = stripeWebhookHandler;
module.exports.flutterwaveWebhookHandler = flutterwaveWebhookHandler;
module.exports.paystackWebhookHandler = paystackWebhookHandler;
