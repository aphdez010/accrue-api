import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// GET /fieldwork - list entries for current user
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1',
      [req.auth.userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { rows } = await pool.query(
      'SELECT * FROM fieldwork_entries WHERE professional_id = $1 ORDER BY entry_date DESC',
      [pro.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /fieldwork - create entry
router.post('/', requireAuth, async (req, res) => {
  try {
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1',
      [req.auth.userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { entry_date, experience_type, hours, supervised, notes } = req.body;
    const { rows: [entry] } = await pool.query(
      `INSERT INTO fieldwork_entries (professional_id, entry_date, experience_type, hours, supervised, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [pro.id, entry_date, experience_type, hours, supervised ?? false, notes ?? null]
    );
    res.status(201).json(entry);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /fieldwork/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM fieldwork_entries WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
