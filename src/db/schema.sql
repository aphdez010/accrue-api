CREATE TABLE IF NOT EXISTS professionals (
  id SERIAL PRIMARY KEY,
  clerk_user_id TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'rbt',
  account_type TEXT, -- 'bcba_trainee' | 'bcaba_trainee' | 'supervisor' (durable view binding, set at onboarding)
  credential_number TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supervisors (
  id SERIAL PRIMARY KEY,
  professional_id INTEGER REFERENCES professionals(id),
  supervisor_name TEXT NOT NULL,
  supervisor_credential TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fieldwork_entries (
  id SERIAL PRIMARY KEY,
  professional_id INTEGER REFERENCES professionals(id) NOT NULL,
  entry_date DATE NOT NULL,
  experience_type TEXT NOT NULL,
  hours NUMERIC(5,2) NOT NULL,
  supervised BOOLEAN DEFAULT false,
  supervisor_id INTEGER REFERENCES supervisors(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supervision_contacts (
  id SERIAL PRIMARY KEY,
  professional_id INTEGER REFERENCES professionals(id) NOT NULL,
  supervisor_id INTEGER REFERENCES supervisors(id),
  contact_date DATE NOT NULL,
  duration_minutes INTEGER NOT NULL,
  contact_type TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
