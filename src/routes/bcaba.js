import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../db/pool.js';
import { checkMonthlyCompliance, adjustMonthlyHours, totalProgress } from './bcaba-rules.js';

const router = express.Router();

async function getProfessionalRole(userId) {
  const result = await pool.query(
    'SELECT id, role, full_name FROM professionals WHERE clerk_user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

router.get('/trainees/:id', requireAuth, async (req, res) => {
  const professional = await getProfessionalRole(req.auth.userId);
  if (!professional) return res.status(403).json({ error: 'Forbidden' });

  const trainee = await pool.query('SELECT * FROM bcaba_trainees WHERE id = $1', [req.params.id]);
  if (!trainee.rows[0]) return res.status(404).json({ error: 'Not found' });

  const monthly = await pool.query(
    'SELECT * FROM bcaba_monthly_verification WHERE trainee_id = $1 ORDER BY month_year',
    [req.params.id]
  );
  const progress = totalProgress(trainee.rows[0], monthly.rows);

  res.json({ trainee: trainee.rows[0], monthly: monthly.rows, progress });
});

// Creates a trainee AND establishes the Responsible Supervisor relationship
// in the same request — both bcaba_trainees.supervisor_id (used for the
// "My Trainees" roster filter) and a matching bcaba_supervisors row (used by
// every monthly/final verification route) must exist for the workflow to
// function. Previously neither was ever written, which meant no supervisor
// could see their roster or touch any verification record.
router.post('/trainees', requireAuth, async (req, res) => {
  const professional = await getProfessionalRole(req.auth.userId);
  if (!professional || !['supervisor', 'owner', 'bcba'].includes(professional.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { fullName, bacbAccountId, pathway, fieldworkType, fieldworkStartDate, targetHours } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const traineeResult = await client.query(
      `INSERT INTO bcaba_trainees
        (user_id, full_name, bacb_account_id, pathway, fieldwork_type, fieldwork_start_date, target_hours, supervisor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.body.userId, fullName, bacbAccountId, pathway, fieldworkType, fieldworkStartDate, targetHours, professional.id]
    );
    const trainee = traineeResult.rows[0];

    const supervisorResult = await client.query(
      `INSERT INTO bcaba_supervisors
        (trainee_id, supervisor_user_id, supervisor_name, is_responsible_supervisor)
       VALUES ($1, $2, $3, true) RETURNING *`,
      [trainee.id, req.auth.userId, professional.full_name]
    );

    await client.query('COMMIT');
    res.status(201).json({ trainee, supervisor: supervisorResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /trainees error:', err);
    res.status(500).json({ error: 'Failed to create trainee' });
  } finally {
    client.release();
  }
});

router.post('/fieldwork-entries', requireAuth, async (req, res) => {
  const professional = await getProfessionalRole(req.auth.userId);
  if (!professional) return res.status(403).json({ error: 'Forbidden' });

  const { traineeId, supervisorId, entryDate, entryType, hours, activityCategory, supervisionFormat, notes, restrictionType, clientPresent, entrySyncType, supervisorPresent } = req.body;
  const loggedByRole = professional.role === 'supervisor' || professional.role === 'owner' ? 'supervisor' : 'trainee';

  const result = await pool.query(
    `INSERT INTO bcaba_fieldwork_entries
      (trainee_id, supervisor_id, entry_date, entry_type, hours, activity_category, supervision_format, notes, logged_by_user_id, logged_by_role, restriction_type, client_present, entry_sync_type, supervisor_present)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [traineeId, supervisorId, entryDate, entryType, hours, activityCategory, supervisionFormat, notes, req.auth.userId, loggedByRole, restrictionType, clientPresent, entrySyncType ?? null, supervisorPresent ?? null]
  );
  res.status(201).json(result.rows[0]);
});

router.get('/trainees/:id/monthly/:monthYear', requireAuth, async (req, res) => {
  const professional = await getProfessionalRole(req.auth.userId);
  if (!professional) return res.status(403).json({ error: 'Forbidden' });

  const { id, monthYear } = req.params;
  const trainee = await pool.query('SELECT fieldwork_type, user_id, supervisor_id FROM bcaba_trainees WHERE id = $1', [id]);
  if (!trainee.rows[0]) return res.status(404).json({ error: 'Not found' });

  const isOwner = trainee.rows[0].user_id === req.auth.userId;
  const isSupervisor = trainee.rows[0].supervisor_id === professional.id;
  if (!isOwner && !isSupervisor) return res.status(403).json({ error: 'Forbidden' });

  const entries = await pool.query(
    `SELECT * FROM bcaba_fieldwork_entries
     WHERE trainee_id = $1 AND date_trunc('month', entry_date) = $2::date`,
    [id, monthYear]
  );

  const rows = entries.rows;
  const totalHours = rows.filter(r => r.entry_type !== 'observation').reduce((s, r) => s + Number(r.hours), 0);
  const supervisedHours = rows.filter(r => r.entry_type === 'supervised').reduce((s, r) => s + Number(r.hours), 0);
  const individualHours = rows.filter(r => r.supervision_format === 'individual').reduce((s, r) => s + Number(r.hours), 0);
  const groupHours = rows.filter(r => r.supervision_format === 'group').reduce((s, r) => s + Number(r.hours), 0);
  const contactsCount = rows.filter(r => r.entry_type === 'supervised').length;
  const observationCompleted = rows.some(r => r.entry_type === 'observation');
  const unrestrictedHours = rows.filter(r => r.restriction_type === 'unrestricted').reduce((s, r) => s + Number(r.hours), 0);
  const restrictedHours = rows.filter(r => r.restriction_type === 'restricted').reduce((s, r) => s + Number(r.hours), 0);
  const unrestrictedPct = totalHours > 0 ? unrestrictedHours / totalHours : 0;
  const clientPresentHours = rows.filter(r => r.client_present === true).reduce((s, r) => s + Number(r.hours), 0);

  const entrySummary = {
    fieldworkType: trainee.rows[0].fieldwork_type,
    totalHours, supervisedHours, individualHours, groupHours, contactsCount, observationCompleted,
    unrestrictedHours, restrictedHours, unrestrictedPct, clientPresentHours,
  };

  const compliance = checkMonthlyCompliance(entrySummary);
  const adjusted = adjustMonthlyHours(entrySummary);

  res.json({ entries: rows, compliance, adjusted, summary: entrySummary });
});

router.get('/supervisor/trainees', requireAuth, async (req, res) => {
  const professional = await getProfessionalRole(req.auth.userId);
  if (!professional) return res.status(403).json({ error: 'Forbidden' });

  const result = await pool.query(
    'SELECT id, full_name, fieldwork_type, target_hours FROM bcaba_trainees WHERE supervisor_id = $1 ORDER BY full_name',
    [professional.id]
  );
  res.json(result.rows);
});

router.post('/monthly-verification/:id/sign', requireAuth, async (req, res) => {
  const professional = await getProfessionalRole(req.auth.userId);
  if (!professional) return res.status(403).json({ error: 'Forbidden' });

  const signField = professional.role === 'supervisor' || professional.role === 'owner'
    ? 'supervisor_signed_at'
    : 'trainee_signed_at';

  const result = await pool.query(
    `UPDATE bcaba_monthly_verification SET ${signField} = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  res.json(result.rows[0]);
});

export default router;