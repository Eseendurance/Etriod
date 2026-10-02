const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');

const router = express.Router();

router.post('/', async (req, res) => {
  const { name, email, plan } = req.body || {};
  if (!name || !email || !plan) return res.status(400).json({ error: 'Name, email, and plan are required.' });
  try {
    await pool.query(
      'INSERT INTO waitlist_signups (id, name, email, plan) VALUES ($1, $2, $3, $4)',
      [crypto.randomUUID(), name, email, plan]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[waitlist/create]', err);
    res.status(500).json({ error: 'Could not join the waitlist.' });
  }
});

module.exports = router;
