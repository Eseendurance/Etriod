const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendMail } = require('../mailer');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, orgId: user.org_id },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, plan: u.plan,
    onboarded: u.onboarded, primaryUse: u.primary_use,
    soundPref: u.sound_pref, suggestionsPref: u.suggestions_pref, role: u.role,
    emailVerified: u.email_verified
  };
}

async function sendVerificationEmail(user) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  await pool.query(
    `INSERT INTO email_verifications (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
    [crypto.randomUUID(), user.id, tokenHash, expiresAt]
  );

  const verifyUrl = `${process.env.APP_URL || 'http://localhost:5500'}/verify-email.html?token=${rawToken}`;
  await sendMail({
    to: user.email,
    subject: 'Verify your ETriod account',
    text: `Hi ${user.name},\n\nConfirm your email to finish setting up ETriod:\n${verifyUrl}\n\nThis link expires in 24 hours.`
  });
}

router.post('/signup', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required.' });
  if (name.length > 100) return res.status(400).json({ error: 'Name is too long.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'Password must be between 8 and 200 characters.' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'An account with that email already exists.' });

    const hash = await bcrypt.hash(password, 12);
    const id = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, name, email.toLowerCase(), hash]
    );
    const user = result.rows[0];
    try {
      await sendVerificationEmail(user);
    } catch (mailErr) {
      // Don't fail signup just because the email couldn't be sent — the user
      // can always hit /resend-verification later. Just log it.
      console.error('[auth/signup] verification email failed to send', mailErr);
    }
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error('[auth/signup]', err);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Incorrect email or password.' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });

    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: 'Could not sign in.' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error('[auth/me]', err);
    res.status(500).json({ error: 'Could not load profile.' });
  }
});

// --- Password reset ---
// Two-step flow: request a reset (always responds the same way, whether or
// not the email exists, so attackers can't use it to discover accounts),
// then confirm with the token that was emailed.

router.post('/request-password-reset', async (req, res) => {
  const { email } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  try {
    const userResult = await pool.query('SELECT id, name FROM users WHERE email = $1', [email.toLowerCase()]);
    if (userResult.rows.length) {
      const user = userResult.rows[0];
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await pool.query(
        `INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
        [crypto.randomUUID(), user.id, tokenHash, expiresAt]
      );

      const resetUrl = `${process.env.APP_URL || 'http://localhost:5500'}/reset-password.html?token=${rawToken}`;
      await sendMail({
        to: email,
        subject: 'Reset your ETriod password',
        text: `Hi ${user.name},\n\nUse this link within the next hour to reset your password:\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`
      });
    }
    // Same response whether or not the account exists.
    res.json({ ok: true, message: 'If an account exists for that email, a reset link has been sent.' });
  } catch (err) {
    console.error('[auth/request-password-reset]', err);
    res.status(500).json({ error: 'Could not process the request.' });
  }
});

router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required.' });
  if (newPassword.length < 8 || newPassword.length > 200) return res.status(400).json({ error: 'Password must be between 8 and 200 characters.' });

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const resetResult = await pool.query(
      `SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [tokenHash]
    );
    if (!resetResult.rows.length) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    const reset = resetResult.rows[0];

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, reset.user_id]);
    await pool.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [reset.id]);

    res.json({ ok: true, message: 'Password updated — you can now sign in.' });
  } catch (err) {
    console.error('[auth/reset-password]', err);
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

// --- Email verification ---

router.post('/verify-email', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token is required.' });

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await pool.query(
      `SELECT * FROM email_verifications WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [tokenHash]
    );
    if (!result.rows.length) return res.status(400).json({ error: 'This verification link is invalid or has expired.' });
    const record = result.rows[0];

    await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [record.user_id]);
    await pool.query('UPDATE email_verifications SET used_at = now() WHERE id = $1', [record.id]);

    res.json({ ok: true, message: 'Email verified — thanks!' });
  } catch (err) {
    console.error('[auth/verify-email]', err);
    res.status(500).json({ error: 'Could not verify email.' });
  }
});

router.post('/resend-verification', requireAuth, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.email_verified) return res.json({ ok: true, message: 'Your email is already verified.' });

    await sendVerificationEmail(user);
    res.json({ ok: true, message: 'Verification email sent.' });
  } catch (err) {
    console.error('[auth/resend-verification]', err);
    res.status(500).json({ error: 'Could not send verification email.' });
  }
});

module.exports = router;
