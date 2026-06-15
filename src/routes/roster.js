import { Router } from 'express';
import { pool } from '../db/pool.js';
import { calcCompliance } from '../services/compliance.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows: rbts } = await pool.query(
      `SELECT id, full_name, email, credential_number, created_at
       FROM professionals WHERE role = 'rbt' AND is_active = true
       ORDER BY full_name`
    );

    const roster = await Promise.all(rbts.map(async (rbt) => {
      const { rows: entries } = await pool.query(
        'SELECT * FROM fieldwork_entries WHERE professional_id = $1',
        [rbt.id]
      );
      const compliance = calcCompliance(entries);
      return {
        id: rbt.id,
        name: rbt.full_name,
        email: rbt.email,
        credential: rbt.credential_number,
        since: rbt.created_at,
        totalHours: compliance.totalHours,
        supervisionPct: compliance.supervisionPct,
        supervisionMet: compliance.supervisionMet,
        restrictedMet: compliance.restrictedMet,
      };
    }));

    res.json(roster);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
