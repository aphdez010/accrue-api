import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { calcCompliance } from '../services/compliance.js';

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1',
      [req.auth.userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { rows: entries } = await pool.query(
      'SELECT * FROM fieldwork_entries WHERE professional_id = $1',
      [pro.id]
    );

    res.json(calcCompliance(entries));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
