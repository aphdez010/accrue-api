import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const OWNER_ID = 'user_3F9tY9Opc2DWMu3q7A51f1kUwKC';

router.post('/run', requireAuth, async (req, res) => {
  if (req.auth.userId !== OWNER_ID) return res.status(403).json({ error: 'Forbidden' });
  try {
    // Links a BCBA `supervisors` record to a real Supervisd account, mirroring
    // bcaba_supervisors.supervisor_user_id. Nullable -- most BCBA supervisors
    // still won't have their own account, so the trainee-captures-both-
    // signatures fallback (built earlier) remains the default; this only
    // activates the stricter, real dual-account flow when a link exists.
    await pool.query(`
      ALTER TABLE supervisors
        ADD COLUMN IF NOT EXISTS supervisor_user_id TEXT;
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_supervisors_supervisor_user_id
      ON supervisors(supervisor_user_id) WHERE supervisor_user_id IS NOT NULL;
    `);

    const after = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'supervisors' ORDER BY column_name
    `);
    res.json({ ok: true, columns: after.rows });
  } catch (err) {
    console.error('admin-migrate error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
