const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/overview', async (req, res) => {
  try {
    const totals = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM users WHERE created_at > now() - interval '30 days') AS new_users_30d,
        (SELECT COUNT(*) FROM conversations) AS total_conversations,
        (SELECT COUNT(*) FROM messages) AS total_messages,
        (SELECT COUNT(DISTINCT user_id) FROM conversations) AS total_active_users,
        (SELECT COUNT(DISTINCT user_id) FROM conversations WHERE last_active_at > now() - interval '24 hours') AS active_last_24h,
        (SELECT COUNT(*) FROM subscriptions WHERE plan = 'team' AND status IN ('active','trialing')) AS active_subscriptions,
        (SELECT COUNT(*) FROM organizations) AS total_companies
    `);

    const dailySeries = await pool.query(`
      SELECT date_trunc('day', created_at) AS day, COUNT(*) AS count
      FROM conversations
      WHERE created_at > now() - interval '14 days'
      GROUP BY date_trunc('day', created_at)
      ORDER BY date_trunc('day', created_at) ASC
    `);

    const recentUsers = await pool.query(`
      SELECT u.id, u.name, u.email,
             COUNT(c.id) AS conversation_count,
             MAX(c.last_active_at) AS last_active_at
      FROM users u
      JOIN conversations c ON c.user_id = u.id
      GROUP BY u.id, u.name, u.email
      ORDER BY MAX(c.last_active_at) DESC
      LIMIT 20
    `);

    res.json({
      totals: totals.rows[0],
      dailySeries: dailySeries.rows,
      recentUsers: recentUsers.rows
    });
  } catch (err) {
    console.error('[admin/overview]', err);
    res.status(500).json({ error: 'Could not load admin data.' });
  }
});

router.get('/companies', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.name, o.created_at, owner.email AS owner_email
       FROM organizations o
       LEFT JOIN organization_members owner_member
         ON owner_member.organization_id = o.id AND owner_member.role = 'owner'
       LEFT JOIN users owner ON owner.id = owner_member.user_id
       ORDER BY o.created_at DESC LIMIT 200`
    );
    const ids = result.rows.map(company => company.id);
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ');
    const [members, activity] = ids.length ? await Promise.all([
      pool.query(
        `SELECT organization_id, COUNT(*) AS member_count
         FROM organization_members WHERE organization_id IN (${placeholders})
         GROUP BY organization_id`,
        ids
      ),
      pool.query(
        `SELECT m.organization_id, COUNT(c.id) AS conversation_count, MAX(c.last_active_at) AS last_active_at
         FROM organization_members m
         LEFT JOIN conversations c ON c.user_id = m.user_id
         WHERE m.organization_id IN (${placeholders})
         GROUP BY m.organization_id`,
        ids
      )
    ]) : [{ rows: [] }, { rows: [] }];
    const membersByCompany = new Map(members.rows.map(row => [row.organization_id, row]));
    const activityByCompany = new Map(activity.rows.map(row => [row.organization_id, row]));
    const companies = result.rows.map(company => ({
      ...company,
      ...(membersByCompany.get(company.id) || { member_count: 0 }),
      ...(activityByCompany.get(company.id) || { conversation_count: 0, last_active_at: null })
    }));
    res.json({ companies: companies.map(({ id, name, owner_email, created_at, member_count, conversation_count, last_active_at }) =>
      ({ id, name, owner_email, created_at, member_count, conversation_count, last_active_at })) });
  } catch (err) {
    console.error('[admin/companies]', err);
    res.status(500).json({ error: 'Could not load company data.' });
  }
});

router.get('/billing', async (req, res) => {
  try {
    const [totals, monthlyPayments, providers] = await Promise.all([
      pool.query(`
        SELECT payment_provider, currency,
          COUNT(*) FILTER (WHERE status = 'paid') AS paid_transactions,
          COALESCE(SUM(paid_amount) FILTER (WHERE status = 'paid'), 0) AS captured_revenue,
          COUNT(*) FILTER (WHERE status = 'pending') AS pending_orders
        FROM payment_orders
        GROUP BY payment_provider, currency
        ORDER BY payment_provider, currency
      `),
      pool.query(`
        SELECT paid_at, currency, payment_provider, paid_amount
        FROM payment_orders
        WHERE status = 'paid' AND paid_at >= date_trunc('month', now()) - interval '5 months'
        ORDER BY paid_at
      `),
      pool.query(`
        SELECT status, COUNT(*) AS count FROM subscriptions
        GROUP BY status ORDER BY status
      `)
    ]);
    const activeSubs = await pool.query(
      `SELECT user_id, payment_provider FROM subscriptions
       WHERE plan = 'team' AND status IN ('active','trialing')`
    );
    const latestPaid = new Map();
    for (let offset = 0; offset < activeSubs.rows.length; offset += 100) {
      const batch = activeSubs.rows.slice(offset, offset + 100);
      const params = [];
      const pairs = batch.map(sub => {
        const userParam = `$${params.push(sub.user_id)}`;
        const providerParam = `$${params.push(sub.payment_provider)}`;
        return `(user_id = ${userParam} AND payment_provider = ${providerParam})`;
      });
      const payments = await pool.query(
        `SELECT user_id, payment_provider, currency, paid_amount
         FROM payment_orders
         WHERE status = 'paid' AND paid_amount IS NOT NULL AND (${pairs.join(' OR ')})
         ORDER BY paid_at DESC`,
        params
      );
      for (const payment of payments.rows) {
        const key = `${payment.user_id}:${payment.payment_provider}`;
        if (!latestPaid.has(key)) latestPaid.set(key, payment);
      }
    }
    const recurring = activeSubs.rows.map(sub => {
      const payment = latestPaid.get(`${sub.user_id}:${sub.payment_provider}`);
      if (payment) return payment;
      const configuredAmount = sub.payment_provider === 'stripe'
        ? Number(process.env.STRIPE_DISPLAY_AMOUNT)
        : sub.payment_provider === 'flutterwave'
          ? Number(process.env.FLUTTERWAVE_TEAM_AMOUNT)
          : Number(process.env.PAYSTACK_TEAM_AMOUNT);
      const configuredCurrency = sub.payment_provider === 'stripe'
        ? (process.env.STRIPE_DISPLAY_CURRENCY || 'USD')
        : sub.payment_provider === 'flutterwave'
          ? (process.env.FLUTTERWAVE_CURRENCY || 'NGN')
          : (process.env.PAYSTACK_CURRENCY || 'NGN');
      if (Number.isFinite(configuredAmount) && configuredAmount > 0) {
        return { currency: configuredCurrency, paid_amount: configuredAmount, payment_provider: sub.payment_provider };
      }
      return null;
    });
    const mrr = new Map();
    for (const payment of recurring.filter(Boolean)) {
      const key = `${payment.payment_provider}:${payment.currency}`;
      const value = mrr.get(key) || { payment_provider: payment.payment_provider, currency: payment.currency, subscribers: 0, estimated_mrr: 0 };
      value.subscribers++;
      value.estimated_mrr += Number(payment.paid_amount);
      mrr.set(key, value);
    }
    const monthly = new Map();
    for (const payment of monthlyPayments.rows) {
      const month = new Date(payment.paid_at);
      month.setUTCDate(1);
      month.setUTCHours(0, 0, 0, 0);
      const key = `${payment.payment_provider}:${payment.currency}:${month.toISOString()}`;
      const value = monthly.get(key) || {
        month: month.toISOString(),
        currency: payment.currency,
        payment_provider: payment.payment_provider,
        revenue: 0,
        transactions: 0
      };
      value.revenue += Number(payment.paid_amount || 0);
      value.transactions++;
      monthly.set(key, value);
    }
    res.json({
      providerTotals: totals.rows,
      monthlyRevenue: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month) ||
        a.payment_provider.localeCompare(b.payment_provider) || a.currency.localeCompare(b.currency)),
      subscriptions: providers.rows,
      estimatedMrr: [...mrr.values()]
    });
  } catch (err) {
    console.error('[admin/billing]', err);
    res.status(500).json({ error: 'Could not load billing analytics.' });
  }
});

module.exports = router;
