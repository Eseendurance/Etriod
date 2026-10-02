const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// List the signed-in user's conversations, most recently active first.
// Supports ?limit= (default 50, max 200) and ?offset= for pagination.
router.get('/', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  try {
    const result = await pool.query(
      `SELECT c.id, c.title, c.created_at, c.last_active_at,
              COUNT(m.id) AS message_count
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE c.user_id = $1
       GROUP BY c.id
       ORDER BY c.last_active_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );
    res.json({ conversations: result.rows, limit, offset });
  } catch (err) {
    console.error('[conversations/list]', err);
    res.status(500).json({ error: 'Could not load conversations.' });
  }
});

// Get one conversation with its full message history.
router.get('/:id', async (req, res) => {
  try {
    const convo = await pool.query(
      'SELECT * FROM conversations WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!convo.rows.length) return res.status(404).json({ error: 'Conversation not found.' });

    const messages = await pool.query(
      `SELECT role, content, created_at FROM (
         SELECT role, content, created_at FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT 500
       ) recent ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ conversation: convo.rows[0], messages: messages.rows });
  } catch (err) {
    console.error('[conversations/get]', err);
    res.status(500).json({ error: 'Could not load conversation.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const id = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, 'New chat') RETURNING *`,
      [id, req.user.id]
    );
    res.status(201).json({ conversation: result.rows[0] });
  } catch (err) {
    console.error('[conversations/create]', err);
    res.status(500).json({ error: 'Could not create conversation.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[conversations/delete]', err);
    res.status(500).json({ error: 'Could not delete conversation.' });
  }
});

module.exports = router;
