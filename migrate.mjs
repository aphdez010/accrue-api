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

console.log('Migration complete');
await pool.end();
