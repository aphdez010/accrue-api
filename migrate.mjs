import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(process.env.HOME, 'accrue-api/.env') });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

await pool.query(`
  ALTER TABLE supervision_contacts
  ADD COLUMN IF NOT EXISTS logged_by_professional_id INTEGER REFERENCES professionals(id);
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS ceus (
    id SERIAL PRIMARY KEY,
    professional_id INTEGER REFERENCES professionals(id) NOT NULL,
    course_title TEXT NOT NULL,
    provider TEXT,
    hours NUMERIC(5,2) NOT NULL,
    completion_date DATE NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    certificate_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`);

// BCaBA: per-entry fieldwork type, so trainees can mix Supervised + Concentrated
// fieldwork per the Handbook's "Combining Fieldwork Types" allowance. Previously
// fixed once per-trainee at onboarding via bcaba_trainees.fieldwork_type, which
// is retained as the trainee's default/primary track.
await pool.query(`
  ALTER TABLE bcaba_fieldwork_entries
  ADD COLUMN IF NOT EXISTS fieldwork_type TEXT NOT NULL DEFAULT 'supervised';
`);

// BCBA-parity documentation fields on BCaBA fieldwork entries: start/end time,
// supervision modality (Face to Face / Video Call / With Client) kept separate
// from the individual/group value already stored in supervision_format,
// supervisor name, and the observation setting + minutes. All nullable and
// documentation-only — the BCaBA compliance engine is unchanged.
await pool.query(`
  ALTER TABLE bcaba_fieldwork_entries
  ADD COLUMN IF NOT EXISTS start_time TEXT,
  ADD COLUMN IF NOT EXISTS end_time TEXT,
  ADD COLUMN IF NOT EXISTS supervision_modality TEXT,
  ADD COLUMN IF NOT EXISTS supervisor_name TEXT,
  ADD COLUMN IF NOT EXISTS setting TEXT,
  ADD COLUMN IF NOT EXISTS observation_minutes INTEGER;
`);

// Supervisor qualifications: certification date + consulting supervisor, per
// Handbook "Supervisor Qualifications" (a supervisor certified less than one
// year must receive monthly consultation from a qualified consulting
// supervisor). Added to both the BCBA and BCaBA supervisors tables.
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

// Professionals: certification + recertification cycle dates, needed to compute
// CEU compliance (32 total / 4 ethics / 3 supervision per 2-year cycle) and to
// know whether a BCBA is in their first year of certification (see above).
await pool.query(`
  ALTER TABLE professionals
  ADD COLUMN IF NOT EXISTS certification_date DATE,
  ADD COLUMN IF NOT EXISTS recertification_date DATE;
`);

// Professionals: account_type is the durable "what is this account" axis
// ('bcba_trainee' | 'bcaba_trainee' | 'supervisor'), set at onboarding and used
// to bind each user to a single dashboard view. Distinct from
// bcba_supervision_track (supervised/concentrated), which is the fieldwork type.
await pool.query(`
  ALTER TABLE professionals
  ADD COLUMN IF NOT EXISTS account_type TEXT;
`);

console.log('Migration complete');
await pool.end();
