import { Router } from 'express';
import { pool } from '../db/pool.js';
import { calcCompliance } from '../services/compliance.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;

    const { rows: [pro] } = await pool.query(
      'SELECT id, bcba_supervision_track, fieldwork_start_date FROM professionals WHERE clerk_user_id = $1',
      [userId]
    );

    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { rows: entries } = await pool.query(
      'SELECT * FROM fieldwork_entries WHERE professional_id = $1',
      [pro.id]
    );

    res.json(calcCompliance(entries, pro.bcba_supervision_track || 'supervised', pro.fieldwork_start_date));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/fieldwork-start-date', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { fieldworkStartDate } = req.body;

    if (!fieldworkStartDate || isNaN(new Date(fieldworkStartDate).getTime())) {
      return res.status(400).json({ error: 'Valid fieldworkStartDate is required' });
    }

    const { rows: [updated] } = await pool.query(
      `UPDATE professionals
       SET fieldwork_start_date = $1
       WHERE clerk_user_id = $2
       RETURNING id, fieldwork_start_date`,
      [fieldworkStartDate, userId]
    );

    if (!updated) return res.status(404).json({ error: 'Professional not found' });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;