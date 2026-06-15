import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initClerk } from './middleware/auth.js';
import fieldworkRouter from './routes/fieldwork.js';
import complianceRouter from './routes/compliance.js';
import rosterRouter from './routes/roster.js';
import ceusRouter from './routes/ceus.js';
import formsRouter from './routes/forms.js';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors({
  origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3010'],
  credentials: true,
}));
app.use(express.json());
app.use(initClerk);

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'supervisd-api' }));
app.use('/fieldwork', fieldworkRouter);
app.use('/compliance', complianceRouter);
app.use('/roster', rosterRouter);
app.use('/ceus', ceusRouter);
app.use('/forms', formsRouter);

app.listen(PORT, () => {
  console.log(`Supervisd API running on port ${PORT}`);
});