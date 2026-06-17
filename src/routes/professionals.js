import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { rows: [pro] } = await pool.query(
      'SELECT * FROM professionals WHERE clerk_user_id = $1', [userId]
    );
    if (!pro) return res.status(404).json({ error: 'Not found' });
    res.json(pro);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const existing = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1', [userId]
    );
    if (existing.rows.length > 0) return res.json(existing.rows[0]);

    const { full_name, email, role, credential_number, bacb_pid, agency_name } = req.body;
    const { rows: [pro] } = await pool.query(
      `INSERT INTO professionals (clerk_user_id, email, full_name, role, credential_number, bacb_pid, agency_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [userId, email, full_name, role || 'rbt', credential_number || null, bacb_pid || null, agency_name || null]
    );
    res.json(pro);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
