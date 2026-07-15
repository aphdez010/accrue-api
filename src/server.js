import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initClerk } from './middleware/auth.js';
import fieldworkRouter from './routes/fieldwork.js';
import complianceRouter from './routes/compliance.js';

import ceusRouter from './routes/ceus.js';
import formsRouter from './routes/forms.js';
import professionalsRouter from './routes/professionals.js';
import invitesRouter from './routes/invites.js';
import exportRouter from './routes/export.js';
import vaultRouter from './routes/vault.js';
import billingRouter from './routes/billing.js';
import bcabaRouter from './routes/bcaba.js';
import invoicesRouter from './routes/invoices.js';
import bcabaMonthlyVerificationRouter from './routes/bcaba-monthly-verification.js';
import bcabaFinalVerificationRouter from './routes/bcaba-final-verification.js';
import bcbaMonthlyVerificationRouter from './routes/bcba-monthly-verification.js';
import bcbaFinalVerificationRouter from './routes/bcba-final-verification.js';
import supervisorsRouter from './routes/supervisors.js';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors({
  origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3010'],
  credentials: true,
}));

app.use('/billing/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(initClerk);

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'supervisd-api' }));
app.use('/fieldwork', fieldworkRouter);
app.use('/compliance', complianceRouter);

app.use('/ceus', ceusRouter);
app.use('/forms', formsRouter);
app.use('/professionals', professionalsRouter);
app.use('/invites', invitesRouter);
app.use('/export', exportRouter);
app.use('/vault', vaultRouter);
app.use('/billing', billingRouter);
app.use('/bcaba', bcabaRouter);
app.use('/invoices', invoicesRouter);
app.use('/bcaba-monthly-verification', bcabaMonthlyVerificationRouter);
app.use('/bcaba-final-verification', bcabaFinalVerificationRouter);
app.use('/bcba-monthly-verification', bcbaMonthlyVerificationRouter);
app.use('/bcba-final-verification', bcbaFinalVerificationRouter);
app.use('/supervisors', supervisorsRouter);


app.listen(PORT, () => {
  console.log(`Supervisd API running on port ${PORT}`);
});