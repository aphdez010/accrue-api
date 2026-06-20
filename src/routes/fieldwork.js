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

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1',
      [req.auth.userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { rows: [existing] } = await pool.query(
      'SELECT id FROM fieldwork_entries WHERE id = $1 AND professional_id = $2',
      [req.params.id, pro.id]
    );
    if (!existing) return res.status(404).json({ error: 'Entry not found' });

    const {
      entry_date, experience_type, hours, supervised, notes,
      activity_description, start_time, end_time, setting,
      supervision_format, task_list_area, task_list_area_number, monthly_observation
    } = req.body;

    const { rows: [entry] } = await pool.query(
      `UPDATE fieldwork_entries
       SET entry_date = $2, experience_type = $3, hours = $4, supervised = $5, notes = $6,
           activity_description = $7, start_time = $8, end_time = $9, setting = $10,
           supervision_format = $11, task_list_area = $12, task_list_area_number = $13, monthly_observation = $14
       WHERE id = $1
       RETURNING *`,
      [
        req.params.id, entry_date, experience_type, hours,
        supervised ?? false, notes ?? null,
        activity_description ?? null, start_time ?? null, end_time ?? null,
        setting ?? null, supervision_format ?? null,
        task_list_area ?? null, task_list_area_number ?? null,
        monthly_observation ?? false
      ]
    );
    res.json(entry);
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
