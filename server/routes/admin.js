const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/overview', async (req, res) => {
  try {
    const totals = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM conversations) AS total_conversations,
        (SELECT COUNT(*) FROM messages) AS total_messages,
        (SELECT COUNT(DISTINCT user_id) FROM conversations) AS total_active_users,
        (SELECT COUNT(DISTINCT user_id) FROM conversations WHERE last_active_at > now() - interval '24 hours') AS active_last_24h
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

module.exports = router;
