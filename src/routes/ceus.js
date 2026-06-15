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
      'SELECT * FROM ceus WHERE professional_id = $1 ORDER BY completion_date DESC',
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
    const { course_title, provider, hours, completion_date, category, certificate_url } = req.body;
    const { rows: [ceu] } = await pool.query(
      `INSERT INTO ceus (professional_id, course_title, provider, hours, completion_date, category, certificate_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [pro.id, course_title, provider || null, hours, completion_date, category || 'general', certificate_url || null]
    );
    res.json(ceu);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1', [userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });
    await pool.query(
      'DELETE FROM ceus WHERE id = $1 AND professional_id = $2',
      [req.params.id, pro.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
