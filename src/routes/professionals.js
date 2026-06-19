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
    const { full_name, email, role, credential_number, bacb_pid, agency_name } = req.body;

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
             agency_name = COALESCE($7, agency_name)
         WHERE clerk_user_id = $1
         RETURNING *`,
        [userId, email || null, full_name || null, role || null, credential_number || null, bacb_pid || null, agency_name || null]
      );
      return res.json(pro);
    }

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
