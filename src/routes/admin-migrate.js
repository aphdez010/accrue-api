import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const OWNER_ID = 'user_3F9tY9Opc2DWMu3q7A51f1kUwKC';

router.post('/run', requireAuth, async (req, res) => {
  if (req.auth.userId !== OWNER_ID) return res.status(403).json({ error: 'Forbidden' });
  try {
    // BCBA-side Monthly Fieldwork Verification Form. Unlike bcaba_monthly_verification,
    // trainee = professional_id (professionals table) and supervisor = supervisor_id
    // (supervisors table) -- BCBA supervisors are NOT linked accounts (no
    // supervisor_user_id column exists on `supervisors`), so both signatures are
    // captured within the trainee's own authenticated session rather than requiring
    // the supervisor to log in separately.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bcba_monthly_verification (
        id SERIAL PRIMARY KEY,
        professional_id INTEGER REFERENCES professionals(id) NOT NULL,
        supervisor_id INTEGER REFERENCES supervisors(id) NOT NULL,
        month_year DATE NOT NULL,
        fieldwork_type TEXT NOT NULL DEFAULT 'supervised',
        independent_hours NUMERIC(7,2) DEFAULT 0,
        supervised_hours NUMERIC(7,2) DEFAULT 0,
        contacts_count INTEGER DEFAULT 0,
        observation_completed BOOLEAN DEFAULT false,
        observation_minutes INTEGER DEFAULT 0,
        individual_supervision_hours NUMERIC(7,2) DEFAULT 0,
        group_supervision_hours NUMERIC(7,2) DEFAULT 0,
        adjusted_hours NUMERIC(7,2) DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft',
        trainee_signature TEXT,
        trainee_signed_at TIMESTAMPTZ,
        supervisor_signature TEXT,
        supervisor_signed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(professional_id, month_year, fieldwork_type)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bcba_final_verifications (
        id SERIAL PRIMARY KEY,
        professional_id INTEGER REFERENCES professionals(id) NOT NULL,
        supervisor_id INTEGER REFERENCES supervisors(id) NOT NULL,
        fieldwork_type TEXT NOT NULL DEFAULT 'supervised',
        period_start_date DATE NOT NULL,
        period_end_date DATE NOT NULL,
        organization_name TEXT,
        total_independent_hours NUMERIC(8,2) DEFAULT 0,
        total_supervised_hours NUMERIC(8,2) DEFAULT 0,
        total_individual_supervision_hours NUMERIC(8,2) DEFAULT 0,
        total_group_supervision_hours NUMERIC(8,2) DEFAULT 0,
        total_fieldwork_hours NUMERIC(8,2) DEFAULT 0,
        percent_supervised NUMERIC(5,2) DEFAULT 0,
        all_monthly_requirements_met BOOLEAN DEFAULT false,
        status TEXT NOT NULL DEFAULT 'draft',
        trainee_signature TEXT,
        trainee_signed_at TIMESTAMPTZ,
        supervisor_signature TEXT,
        supervisor_signed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bcba_final_verification_months (
        final_verification_id INTEGER REFERENCES bcba_final_verifications(id) NOT NULL,
        monthly_verification_id INTEGER REFERENCES bcba_monthly_verification(id) NOT NULL,
        PRIMARY KEY (final_verification_id, monthly_verification_id)
      );
    `);

    const after = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('bcba_monthly_verification','bcba_final_verifications','bcba_final_verification_months')
    `);
    res.json({ ok: true, tables: after.rows });
  } catch (err) {
    console.error('admin-migrate error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
