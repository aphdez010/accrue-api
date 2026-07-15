import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Same production owner ID confirmed elsewhere in this codebase (billing.js
// uses a different, local-dev ID — this one is the live production owner).
const OWNER_ID = 'user_3F9tY9Opc2DWMu3q7A51f1kUwKC';

router.post('/run', requireAuth, async (req, res) => {
  if (req.auth.userId !== OWNER_ID) return res.status(403).json({ error: 'Forbidden' });
  try {
    const before = await pool.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('bcaba_fieldwork_entries','supervisors','bcaba_supervisors','professionals')
      ORDER BY table_name, column_name
    `);

    await pool.query(`
      ALTER TABLE bcaba_fieldwork_entries
        ADD COLUMN IF NOT EXISTS fieldwork_type TEXT NOT NULL DEFAULT 'supervised';
    `);
    await pool.query(`
      ALTER TABLE supervisors
        ADD COLUMN IF NOT EXISTS supervisor_certification_date DATE,
        ADD COLUMN IF NOT EXISTS consulting_supervisor_name TEXT,
        ADD COLUMN IF NOT EXISTS consulting_supervisor_last_consultation_date DATE;
    `);
    await pool.query(`
      ALTER TABLE bcaba_supervisors
        ADD COLUMN IF NOT EXISTS supervisor_certification_date DATE,
        ADD COLUMN IF NOT EXISTS consulting_supervisor_name TEXT,
        ADD COLUMN IF NOT EXISTS consulting_supervisor_last_consultation_date DATE;
    `);
    await pool.query(`
      ALTER TABLE professionals
        ADD COLUMN IF NOT EXISTS certification_date DATE,
        ADD COLUMN IF NOT EXISTS recertification_date DATE;
    `);

    const after = await pool.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('bcaba_fieldwork_entries','supervisors','bcaba_supervisors','professionals')
      ORDER BY table_name, column_name
    `);

    res.json({ ok: true, before: before.rows, after: after.rows });
  } catch (err) {
    console.error('admin-migrate error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
