import pg from 'pg';
const pool = new pg.Pool({
  host: 'switchback.proxy.rlwy.net',
  port: 54372,
  database: 'railway',
  user: 'postgres',
  password: 'YRL_JbaRhXDtMRnvKZKBHNfIeDbIWPJuc',
  ssl: false,
});
try {
  await pool.query(`INSERT INTO professionals (clerk_user_id, email, first_name, last_name, role) VALUES ('user_3F9tY9Opc2DWMu3q7A51f1kUwKC', 'aphdez010@gmail.com', 'Arian', 'Perez', 'bcba') ON CONFLICT (clerk_user_id) DO NOTHING`);
  const { rows } = await pool.query('SELECT clerk_user_id, email, role FROM professionals');
  console.log('✅ seeded. professionals table:', rows);
} catch (e) {
  console.error('❌', e.message);
} finally {
  await pool.end();
}
