import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1', [userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });
    const { rows } = await pool.query(
      `SELECT sc.*, p.full_name as supervisee_name
       FROM supervision_contacts sc
       JOIN professionals p ON p.id = sc.professional_id
       WHERE sc.logged_by_professional_id = $1
       ORDER BY sc.contact_date DESC`,
      [pro.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1', [userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });
    const { supervisee_id, contact_date, duration_minutes, contact_type, notes } = req.body;
    const { rows: [contact] } = await pool.query(
      `INSERT INTO supervision_contacts (professional_id, contact_date, duration_minutes, contact_type, notes, logged_by_professional_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [supervisee_id, contact_date, duration_minutes, contact_type, notes || null, pro.id]
    );
    res.json(contact);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
