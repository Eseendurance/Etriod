const jwt = require('jsonwebtoken');

// Verifies the "Authorization: Bearer <token>" header and attaches req.user = { id, email, role, orgId }.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in.' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
  }
}

async function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const { pool } = require('../db');
    const result = await pool.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    if (!result.rows.length || result.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
  } catch (err) {
    console.error('[auth/require-admin]', err);
    res.status(500).json({ error: 'Could not verify administrator access.' });
  }
}

module.exports = { requireAuth, requireAdmin };
