import { Router } from 'express';
import { pool } from '../db/pool.js';
import { calcCompliance } from '../services/compliance.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    console.log("[comp] userId:", userId);

    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1',
      [userId]
    );

    console.log("[comp] pro:", JSON.stringify(pro));
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { rows: entries } = await pool.query(
      'SELECT * FROM fieldwork_entries WHERE professional_id = $1',
      [pro.id]
    );

    console.log("[comp] entries:", entries.length);
    res.json(calcCompliance(entries));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;