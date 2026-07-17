import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router();
router.get('/me', requireAuth, async (req, res) =>{
  try {
    const { userId } = req.auth;
    const { rows: [pro] } = await pool.query(
      'SELECT * FROM professionals WHERE clerk_user_id = $1', [userId]
    );
    if (!pro) return res.status(404).json({ error:'Not found' });
    res.json(pro);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// GET /professionals/lookup?email=... — used when a supervisor needs to
// attach an existing Supervisd account to a new trainee/roster record.
// Returns only minimal, non-sensitive fields — never the clerk_user_id
// directly to the client; callers that need to link an account (e.g.
// trainee creation) resolve it server-side from this same email instead.
router.get('/lookup', requireAuth, async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email is required' });
    const { rows: [pro] } = await pool.query(
      'SELECT id, full_name, email, role FROM professionals WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    if (!pro) return res.status(404).json({ error: 'No Supervisd account found for that email' });
    res.json(pro);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { full_name, email, role, credential_number, bacb_pid, agency_name, account_type } = req.body;
    // account_type is the durable "what is this account" axis:
    //   'bcba_trainee' | 'bcaba_trainee' | 'supervisor'
    // It's set once at onboarding and is what the app uses to decide which
    // view a user sees. It is NOT the same as bcba_supervision_track
    // (supervised/concentrated), which is the fieldwork *type* for trainees.
    const VALID_ACCOUNT_TYPES = ['bcba_trainee', 'bcaba_trainee', 'supervisor'];
    const accountType = VALID_ACCOUNT_TYPES.includes(account_type) ? account_type : null;
    const existing = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1', [userId]
    );
    if (existing.rows.length > 0) {
      const { rows: [pro] } = await pool.query(
        `UPDATE professionals
         SET email = COALESCE($2, email),
             full_name = COALESCE($3, full_name),
             role = COALESCE($4, role),
             credential_number = COALESCE($5, credential_number),
             bacb_pid = COALESCE($6, bacb_pid),
             agency_name = COALESCE($7, agency_name),
             account_type = COALESCE($8, account_type)
         WHERE clerk_user_id = $1
         RETURNING *`,
        [userId, email || null, full_name || null, role || null, credential_number || null, bacb_pid || null, agency_name || null, accountType]
      );
      return res.json(pro);
    }
    const { rows: [pro] } = await pool.query(
      `INSERT INTO professionals (clerk_user_id, email, full_name, role, credential_number, bacb_pid, agency_name, account_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [userId, email, full_name, role || 'rbt', credential_number || null, bacb_pid || null, agency_name || null, accountType]
    );
    res.json(pro);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.patch('/track', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { track } = req.body;
    if (!['supervised', 'concentrated'].includes(track)) {
      return res.status(400).json({ error: 'Invalid track. Must be "supervised" or "concentrated".' });
    }
    const { rows: [pro] } = await pool.query(
      'UPDATE professionals SET bcba_supervision_track = $2 WHERE clerk_user_id = $1 RETURNING *',
      [userId, track]
    );
    if (!pro) return res.status(404).json({ error:'Not found' });
    res.json(pro);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
export default router;