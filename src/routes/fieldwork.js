import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

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

router.post('/', requireAuth, async (req, res) => {
  try {
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1',
      [req.auth.userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const {
      entry_date, experience_type, hours, supervised, notes,
      activity_description, start_time, end_time, setting,
      supervision_format, task_list_area, task_list_area_number, monthly_observation
    } = req.body;

    const { rows: [entry] } = await pool.query(
      `INSERT INTO fieldwork_entries
        (professional_id, entry_date, experience_type, hours, supervised, notes,
         activity_description, start_time, end_time, setting,
         supervision_format, task_list_area, task_list_area_number, monthly_observation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        pro.id, entry_date, experience_type, hours,
        supervised ?? false, notes ?? null,
        activity_description ?? null, start_time ?? null, end_time ?? null,
        setting ?? null, supervision_format ?? null,
        task_list_area ?? null, task_list_area_number ?? null,
        monthly_observation ?? false
      ]
    );
    res.status(201).json(entry);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM fieldwork_entries WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
