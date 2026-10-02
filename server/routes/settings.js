const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.put('/', async (req, res) => {
  const { soundPref, suggestionsPref, onboarded, primaryUse, name } = req.body || {};
  try {
    const result = await pool.query(
      `UPDATE users SET
         sound_pref = COALESCE($1, sound_pref),
         suggestions_pref = COALESCE($2, suggestions_pref),
         onboarded = COALESCE($3, onboarded),
         primary_use = COALESCE($4, primary_use),
         name = COALESCE($5, name)
       WHERE id = $6
       RETURNING id, name, email, sound_pref, suggestions_pref, onboarded, primary_use`,
      [soundPref, suggestionsPref, onboarded, primaryUse, name, req.user.id]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('[settings/update]', err);
    res.status(500).json({ error: 'Could not save settings.' });
  }
});

// Deletes all of the signed-in user's conversation history (not the account itself).
router.delete('/history', async (req, res) => {
  try {
    await pool.query('DELETE FROM conversations WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[settings/clear-history]', err);
    res.status(500).json({ error: 'Could not clear history.' });
  }
});

module.exports = router;
