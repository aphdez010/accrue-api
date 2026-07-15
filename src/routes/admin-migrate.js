import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const OWNER_ID = 'user_3F9tY9Opc2DWMu3q7A51f1kUwKC';

router.post('/run', requireAuth, async (req, res) => {
  if (req.auth.userId !== OWNER_ID) return res.status(403).json({ error: 'Forbidden' });
  try {
    // Lets a trainee have a separate M-FVF draft per fieldwork type for the same
    // month (previously one row per trainee/month, with no way to represent a
    // month where the trainee logged both Supervised and Concentrated hours).
    // Backfill existing rows from the trainee's current primary track so nothing
    // orphans the uniqueness constraint below.
    await pool.query(`
      ALTER TABLE bcaba_monthly_verification
        ADD COLUMN IF NOT EXISTS fieldwork_type TEXT;
    `);
    await pool.query(`
      UPDATE bcaba_monthly_verification mv
      SET fieldwork_type = t.fieldwork_type
      FROM bcaba_trainees t
      WHERE mv.trainee_id = t.id AND mv.fieldwork_type IS NULL;
    `);
    await pool.query(`
      ALTER TABLE bcaba_monthly_verification
        ALTER COLUMN fieldwork_type SET DEFAULT 'supervised',
        ALTER COLUMN fieldwork_type SET NOT NULL;
    `);
    // Replace the old (trainee_id, month_year) uniqueness with one that also
    // includes fieldwork_type, so two drafts (one per type) can coexist for the
    // same month. Drop the old constraint by whatever name Postgres assigned it.
    const { rows: idx } = await pool.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'bcaba_monthly_verification'::regclass AND contype = 'u';
    `);
    for (const row of idx) {
      await pool.query(`ALTER TABLE bcaba_monthly_verification DROP CONSTRAINT IF EXISTS ${row.conname};`);
    }
    const { rows: existingNew } = await pool.query(`
      SELECT 1 FROM pg_constraint WHERE conname = 'bcaba_monthly_verification_trainee_month_type_unique';
    `);
    if (existingNew.length === 0) {
      await pool.query(`
        ALTER TABLE bcaba_monthly_verification
        ADD CONSTRAINT bcaba_monthly_verification_trainee_month_type_unique
        UNIQUE (trainee_id, month_year, fieldwork_type);
      `);
    }

    const after = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'bcaba_monthly_verification' ORDER BY column_name
    `);
    res.json({ ok: true, after: after.rows });
  } catch (err) {
    console.error('admin-migrate error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
