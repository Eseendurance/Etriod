const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');

const router = express.Router();

function authorized(req) {
  const configured = process.env.CRON_SECRET;
  const supplied = req.headers.authorization || '';
  if (!configured || !supplied.startsWith('Bearer ')) return false;
  const expected = Buffer.from(`Bearer ${configured}`);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

router.get('/cleanup', async (req, res) => {
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'Scheduled cleanup is not configured.' });
  if (!authorized(req)) return res.status(401).json({ error: 'Scheduled cleanup is not authorized.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const limits = await client.query(
      `DELETE FROM rate_limit_counters WHERE reset_at < now() - interval '1 day'`
    );
    const resets = await client.query(
      `DELETE FROM password_resets WHERE expires_at < now() - interval '7 days'`
    );
    const verifications = await client.query(
      `DELETE FROM email_verifications WHERE expires_at < now() - interval '7 days'`
    );
    await client.query('COMMIT');
    res.json({
      ok: true,
      ranAt: new Date().toISOString(),
      deleted: {
        rateLimits: limits.rowCount,
        passwordResets: resets.rowCount,
        emailVerifications: verifications.rowCount
      }
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[cron/cleanup]', err);
    res.status(500).json({ error: 'Scheduled cleanup failed.' });
  } finally {
    client.release();
  }
});

module.exports = router;
