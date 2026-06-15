import 'dotenv/config';
import { pool } from './db/pool.js';

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
