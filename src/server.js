import 'dotenv/config';
import { pool } from './db/pool.js';

if (process.env.SEED_USER === 'true') {
  pool.query(
    `INSERT INTO professionals (clerk_user_id, email, first_name, last_name, role)
     VALUES ('user_3F9tY9Opc2DWMu3q7A51f1kUwKC', 'aphdez010@gmail.com', 'Arian', 'Perez', 'bcba')
     ON CONFLICT (clerk_user_id) DO NOTHING`
  ).then(() => console.log('✅ production user seeded'))
   .catch(e => console.error('❌ seed failed:', e.message));
}
import express from 'express';
import cors from 'cors';
import { initClerk } from './middleware/auth.js';
import fieldworkRouter from './routes/fieldwork.js';
import complianceRouter from './routes/compliance.js';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors({
  origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3010'],
  credentials: true,
}));
app.use(express.json());
app.use(initClerk);

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'accrue-api' }));
app.use('/fieldwork', fieldworkRouter);
app.use('/compliance', complianceRouter);

app.listen(PORT, () => {
  console.log(`Accrue API running on port ${PORT}`);
});
