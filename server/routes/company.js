const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function membershipFor(userId) {
  const result = await pool.query(
    `SELECT m.organization_id, m.role, o.name, owner.user_id AS owner_id
     FROM organization_members m
     JOIN organizations o ON o.id = m.organization_id
     JOIN organization_members owner ON owner.organization_id = o.id AND owner.role = 'owner'
     WHERE m.user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function companyIsEntitled(ownerId) {
  const owner = await pool.query('SELECT plan FROM users WHERE id = $1', [ownerId]);
  if (!owner.rows.length) return false;
  if (owner.rows[0].plan === 'enterprise') return true;
  const subscription = await pool.query(
    `SELECT 1 FROM subscriptions
     WHERE user_id = $1 AND plan = 'team' AND status IN ('active', 'trialing')
     LIMIT 1`,
    [ownerId]
  );
  return subscription.rows.length > 0;
}

async function requireCompanyRole(req, res, roles) {
  const membership = await membershipFor(req.user.id);
  if (!membership) {
    res.status(404).json({ error: 'You are not a member of a company workspace.' });
    return null;
  }
  if (!roles.includes(membership.role)) {
    res.status(403).json({ error: 'Company owner or admin access is required.' });
    return null;
  }
  return membership;
}

router.get('/overview', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const membership = await membershipFor(req.user.id);
    if (!membership) {
      return res.status(404).json({ error: 'You are not a member of a company workspace.' });
    }
    if (!await companyIsEntitled(membership.owner_id)) {
      return res.status(402).json({ error: 'The company owner needs an active Team or Enterprise plan to access this workspace.' });
    }
    const stats = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM organization_members WHERE organization_id = $1) AS members,
           (SELECT COUNT(DISTINCT m.conversation_id)
             FROM messages m JOIN conversations c ON c.id = m.conversation_id
             JOIN organization_members om ON om.user_id = c.user_id
             WHERE om.organization_id = $1) AS conversations,
           (SELECT COUNT(*)
             FROM messages m JOIN conversations c ON c.id = m.conversation_id
             JOIN organization_members om ON om.user_id = c.user_id
             WHERE om.organization_id = $1 AND m.created_at >= now() - interval '30 days') AS messages_30d,
           (SELECT COUNT(DISTINCT c.user_id)
             FROM conversations c JOIN organization_members om ON om.user_id = c.user_id
             WHERE om.organization_id = $1 AND c.last_active_at >= now() - interval '7 days') AS active_members_7d`,
        [membership.organization_id]
      );
    const memberPage = await pool.query(
      `SELECT u.id, u.name, u.email, om.role
       FROM organization_members om JOIN users u ON u.id = om.user_id
       WHERE om.organization_id = $1
       ORDER BY u.name LIMIT $2 OFFSET $3`,
      [membership.organization_id, limit + 1, offset]
    );
    const hasMore = memberPage.rows.length > limit;
    const pageRows = memberPage.rows.slice(0, limit);
    const ids = pageRows.map(member => member.id);
    const activityRows = ids.length ? await pool.query(
      `SELECT user_id, COUNT(*) AS conversation_count, MAX(last_active_at) AS last_active_at
       FROM conversations WHERE user_id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})
       GROUP BY user_id`,
      ids
    ) : { rows: [] };
    const activityByUser = new Map(activityRows.rows.map(row => [row.user_id, row]));
    const safeMembers = pageRows.map(({ id, name, email, role }) => {
      const activity = activityByUser.get(id) || { conversation_count: 0, last_active_at: null };
      return { id, name, email, role, conversation_count: activity.conversation_count, last_active_at: activity.last_active_at };
    });
    res.json({
      company: { id: membership.organization_id, name: membership.name, role: membership.role },
      stats: stats.rows[0],
      members: safeMembers,
      pagination: { limit, offset, hasMore }
    });
  } catch (err) {
    console.error('[company/overview]', err);
    res.status(500).json({ error: 'Could not load company workspace.' });
  }
});

router.post('/', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 120) return res.status(400).json({ error: 'Company name must be between 1 and 120 characters.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await client.query('SELECT plan, org_id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    if (!account.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found.' });
    }
    const paid = account.rows[0].plan === 'enterprise' || (await client.query(
      `SELECT 1 FROM subscriptions WHERE user_id = $1 AND plan = 'team'
       AND status IN ('active','trialing') LIMIT 1`,
      [req.user.id]
    )).rows.length > 0;
    if (!paid) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'A Team or Enterprise subscription is required to create a company workspace.' });
    }
    if (account.rows[0].org_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Your account already belongs to a company workspace.' });
    }
    const orgId = crypto.randomUUID();
    await client.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, name]);
    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [orgId, req.user.id]
    );
    await client.query('UPDATE users SET org_id = $1 WHERE id = $2', [orgId, req.user.id]);
    await client.query('COMMIT');
    res.status(201).json({ company: { id: orgId, name, role: 'owner' } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[company/create]', err);
    res.status(500).json({ error: 'Could not create company workspace.' });
  } finally {
    client.release();
  }
});

router.post('/members', async (req, res) => {
  const membership = await requireCompanyRole(req, res, ['owner', 'admin']);
  if (!membership) return;
  if (!await companyIsEntitled(membership.owner_id)) {
    return res.status(402).json({ error: 'The company owner needs an active Team or Enterprise plan to manage this workspace.' });
  }
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid account email address.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query('SELECT id, name, email, org_id FROM users WHERE email = $1 FOR UPDATE', [email]);
    if (!target.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That person needs to create an Etriod account before being added.' });
    }
    if (target.rows[0].org_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That account already belongs to a company workspace.' });
    }
    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')`,
      [membership.organization_id, target.rows[0].id]
    );
    await client.query('UPDATE users SET org_id = $1 WHERE id = $2', [membership.organization_id, target.rows[0].id]);
    await client.query('COMMIT');
    res.status(201).json({ member: { ...target.rows[0], role: 'member' } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'That account already belongs to a company workspace.' });
    console.error('[company/add-member]', err);
    res.status(500).json({ error: 'Could not add company member.' });
  } finally {
    client.release();
  }
});

router.patch('/members/:userId', async (req, res) => {
  const membership = await requireCompanyRole(req, res, ['owner', 'admin']);
  if (!membership) return;
  if (!await companyIsEntitled(membership.owner_id)) {
    return res.status(402).json({ error: 'The company owner needs an active Team or Enterprise plan to manage this workspace.' });
  }
  const role = req.body?.role;
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Choose admin or member.' });
  if (membership.role !== 'owner' && role === 'admin') return res.status(403).json({ error: 'Only the company owner can grant admin access.' });
  try {
    const currentRole = await pool.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [membership.organization_id, req.params.userId]
    );
    if (!currentRole.rows.length || currentRole.rows[0].role === 'owner' ||
      (membership.role !== 'owner' && currentRole.rows[0].role !== 'member')) {
      return res.status(404).json({ error: 'Member not found or their role cannot be changed by your account.' });
    }
    const result = await pool.query(
      `UPDATE organization_members SET role = $1
       WHERE organization_id = $2 AND user_id = $3 AND role <> 'owner'
       RETURNING user_id, role`,
      [role, membership.organization_id, req.params.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Member not found or owner role cannot be changed here.' });
    res.json({ member: result.rows[0] });
  } catch (err) {
    console.error('[company/update-role]', err);
    res.status(500).json({ error: 'Could not update member role.' });
  }
});

router.delete('/members/:userId', async (req, res) => {
  const membership = await requireCompanyRole(req, res, ['owner', 'admin']);
  if (!membership) return;
  if (req.params.userId === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself from the company workspace.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (membership.role !== 'owner') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the company owner can remove members.' });
    }
    const target = await client.query(
      `DELETE FROM organization_members
       WHERE organization_id = $1 AND user_id = $2 AND role <> 'owner'
       RETURNING user_id`,
      [membership.organization_id, req.params.userId]
    );
    if (!target.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Member not found or company owner cannot be removed.' });
    }
    await client.query('UPDATE users SET org_id = NULL WHERE id = $1 AND org_id = $2', [req.params.userId, membership.organization_id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[company/remove-member]', err);
    res.status(500).json({ error: 'Could not remove company member.' });
  } finally {
    client.release();
  }
});

module.exports = router;
