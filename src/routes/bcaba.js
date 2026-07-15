import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../db/pool.js';
import { checkMonthlyCompliance, adjustMonthlyHours, totalProgress, combinedTotal } from './bcaba-rules.js';
import { computeSupervisorQualification } from './supervisor-qualifications.js';

const router = express.Router();

async function getProfessionalRole(userId) {
  const result = await pool.query(
    'SELECT id, role, full_name FROM professionals WHERE clerk_user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

// GET /bcaba/me — resolves the calling user's own bcaba_trainees record by
// their Clerk user id. Needed because bcaba_trainees.id is NOT the same as
// professionals.id — they're separate tables linked by user_id, not by
// matching primary keys. Use this (not professionals.id) whenever the
// frontend needs "my own trainee id" for calls like
// /bcaba/trainees/:id/supervisors, /bcaba/trainees/:id/monthly/:monthYear,
// or as the traineeId in POST /bcaba/fieldwork-entries.
router.get('/me', requireAuth, async (req, res) => {
  const { userId } = req.auth;
  const trainee = await pool.query('SELECT * FROM bcaba_trainees WHERE user_id = $1', [userId]);
  if (!trainee.rows[0]) return res.status(404).json({ error: 'No BCaBA trainee record found for your account' });
  res.json(trainee.rows[0]);
});

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
// function.
//
// Trainees must already have a Supervisd account (created via normal
// sign-up) before a supervisor can add them — we resolve the trainee's
// account server-side by email rather than trusting a client-supplied
// userId, which was a latent trust gap in the original implementation.
router.post('/trainees', requireAuth, async (req, res) => {
  const professional = await getProfessionalRole(req.auth.userId);
  if (!professional || !['supervisor', 'owner', 'bcba'].includes(professional.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { traineeEmail, bacbAccountId, pathway, fieldworkType, fieldworkStartDate, targetHours } = req.body;
  if (!traineeEmail) return res.status(400).json({ error: 'traineeEmail is required' });

  const { rows: [traineeAccount] } = await pool.query(
    'SELECT clerk_user_id, full_name FROM professionals WHERE LOWER(email) = LOWER($1)',
    [traineeEmail]
  );
  if (!traineeAccount) {
    return res.status(404).json({ error: 'No Supervisd account found for that email. The trainee needs to sign up first.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingTrainee = await client.query(
      'SELECT id FROM bcaba_trainees WHERE user_id = $1',
      [traineeAccount.clerk_user_id]
    );
    if (existingTrainee.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This person is already registered as a BCaBA trainee' });
    }

    const traineeResult = await client.query(
      `INSERT INTO bcaba_trainees
        (user_id, full_name, bacb_account_id, pathway, fieldwork_type, fieldwork_start_date, target_hours, supervisor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [traineeAccount.clerk_user_id, traineeAccount.full_name, bacbAccountId, pathway, fieldworkType, fieldworkStartDate, targetHours, professional.id]
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

  const { traineeId, supervisorId, entryDate, entryType, hours, activityCategory, supervisionFormat, notes, restrictionType, entrySyncType, activityDescription, taskListArea, taskListAreaNumber, fieldworkType } = req.body;
  const loggedByRole = professional.role === 'supervisor' || professional.role === 'owner' ? 'supervisor' : 'trainee';

  // fieldworkType lets a trainee tag this specific entry as Supervised or
  // Concentrated Supervised Fieldwork, so hours can be mixed across tracks per
  // the Handbook's Combining Fieldwork Types allowance. Defaults to the
  // trainee's primary track for trainees who never mix types.
  let resolvedFieldworkType = fieldworkType;
  if (!resolvedFieldworkType) {
    const { rows: [trainee] } = await pool.query('SELECT fieldwork_type FROM bcaba_trainees WHERE id = $1', [traineeId]);
    resolvedFieldworkType = trainee?.fieldwork_type || 'supervised';
  }

  const result = await pool.query(
    `INSERT INTO bcaba_fieldwork_entries
      (trainee_id, supervisor_id, entry_date, entry_type, hours, activity_category, supervision_format, notes, logged_by_user_id, logged_by_role, restriction_type, entry_sync_type, activity_description, task_list_area, task_list_area_number, fieldwork_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
    [traineeId, supervisorId, entryDate, entryType, hours, activityCategory, supervisionFormat, notes, req.auth.userId, loggedByRole, restrictionType, entrySyncType ?? null, activityDescription ?? null, taskListArea ?? null, taskListAreaNumber ?? null, resolvedFieldworkType]
  );
  res.status(201).json(result.rows[0]);
});

router.patch('/fieldwork-entries/:id', requireAuth, async (req, res) => {
  const professional = await getProfessionalRole(req.auth.userId);
  if (!professional) return res.status(403).json({ error: 'Forbidden' });

  const { id } = req.params;
  const { rows: [entry] } = await pool.query('SELECT * FROM bcaba_fieldwork_entries WHERE id = $1', [id]);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  const { rows: [trainee] } = await pool.query('SELECT user_id, supervisor_id FROM bcaba_trainees WHERE id = $1', [entry.trainee_id]);
  const isOwner = trainee?.user_id === req.auth.userId;
  const isSupervisor = trainee?.supervisor_id === professional.id;
  if (!isOwner && !isSupervisor) return res.status(403).json({ error: 'Forbidden' });

  const { entryDate, entryType, hours, activityCategory, supervisionFormat, notes, restrictionType, entrySyncType, activityDescription, taskListArea, taskListAreaNumber, fieldworkType } = req.body;

  const result = await pool.query(
    `UPDATE bcaba_fieldwork_entries SET
       entry_date = COALESCE($1, entry_date), entry_type = COALESCE($2, entry_type),
       hours = COALESCE($3, hours), activity_category = COALESCE($4, activity_category),
       supervision_format = COALESCE($5, supervision_format), notes = $6,
       restriction_type = COALESCE($7, restriction_type),
       entry_sync_type = COALESCE($8, entry_sync_type),
       activity_description = $9, task_list_area = $10, task_list_area_number = $11,
       fieldwork_type = COALESCE($12, fieldwork_type)
     WHERE id = $13 RETURNING *`,
    [entryDate, entryType, hours, activityCategory, supervisionFormat, notes ?? null, restrictionType, entrySyncType, activityDescription ?? null, taskListArea ?? null, taskListAreaNumber ?? null, fieldworkType, id]
  );
  res.json(result.rows[0]);
});

router.delete('/fieldwork-entries/:id', requireAuth, async (req, res) => {
  const professional = await getProfessionalRole(req.auth.userId);
  if (!professional) return res.status(403).json({ error: 'Forbidden' });

  const { id } = req.params;
  const { rows: [entry] } = await pool.query('SELECT * FROM bcaba_fieldwork_entries WHERE id = $1', [id]);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  const { rows: [trainee] } = await pool.query('SELECT user_id, supervisor_id FROM bcaba_trainees WHERE id = $1', [entry.trainee_id]);
  const isOwner = trainee?.user_id === req.auth.userId;
  const isSupervisor = trainee?.supervisor_id === professional.id;
  if (!isOwner && !isSupervisor) return res.status(403).json({ error: 'Forbidden' });

  await pool.query('DELETE FROM bcaba_fieldwork_entries WHERE id = $1', [id]);
  res.json({ ok: true });
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

  // Builds the same summary shape for an arbitrary subset of this month's rows.
  // Observation entries represent a supervisor directly observing the trainee —
  // supervised time, not independent time, and not something to exclude from
  // the total (previously these hours were dropped entirely here, while the
  // M-FVF draft route counted them as independent — the two disagreed on the
  // same data; both now treat observation entries as supervised, consistently).
  function summarize(subset, fieldworkType) {
    const supervisedHours = subset.filter(r => r.entry_type === 'supervised' || r.entry_type === 'observation').reduce((s, r) => s + Number(r.hours), 0);
    const totalHours = subset.reduce((s, r) => s + Number(r.hours), 0);
    const independentHours = totalHours - supervisedHours;
    const individualHours = subset.filter(r => r.supervision_format === 'individual').reduce((s, r) => s + Number(r.hours), 0);
    const groupHours = subset.filter(r => r.supervision_format === 'group').reduce((s, r) => s + Number(r.hours), 0);
    // Supervisor-trainee contacts: real-time interactions only, per Handbook
    // p.20 — matches the equivalent rule on the BCBA side and the M-FVF draft
    // route. Previously counted any 'supervised'-typed entry regardless of
    // sync type, even though sync type is captured per entry.
    const contactsCount = subset.filter(r => (r.entry_type === 'supervised' || r.entry_type === 'observation') && r.entry_sync_type === 'synchronized').length;
    const observationCompleted = subset.some(r => r.entry_type === 'observation');
    const unrestrictedHours = subset.filter(r => r.restriction_type === 'unrestricted').reduce((s, r) => s + Number(r.hours), 0);
    const restrictedHours = subset.filter(r => r.restriction_type === 'restricted').reduce((s, r) => s + Number(r.hours), 0);
    const unrestrictedPct = totalHours > 0 ? unrestrictedHours / totalHours : 0;
    const summary = {
      fieldworkType, totalHours, supervisedHours, independentHours, individualHours, groupHours, contactsCount, observationCompleted,
      unrestrictedHours, restrictedHours, unrestrictedPct,
    };
    return { summary, compliance: checkMonthlyCompliance(summary), adjusted: adjustMonthlyHours(summary) };
  }

  // Top-level summary/compliance/adjusted (kept for backward compatibility with
  // existing callers): the trainee's combined activity this month across
  // whichever fieldwork type(s) they logged, using their primary track's rules.
  // This is what most trainees see, since most never mix types.
  const overall = summarize(rows, trainee.rows[0].fieldwork_type);

  // Per-type breakdown: entries can now be individually tagged Supervised or
  // Concentrated (see fieldwork_type on the entry), and each type has its own
  // monthly rules (contacts, supervision %, min/max hours, and — for
  // Concentrated — no proration allowed at all). A trainee who mixed types
  // this month needs each subset checked against ITS OWN rules, not the
  // trainee's single primary-track rules applied uniformly.
  const byType = {
    supervised: summarize(rows.filter(r => (r.fieldwork_type || 'supervised') === 'supervised'), 'supervised'),
    concentrated: summarize(rows.filter(r => r.fieldwork_type === 'concentrated'), 'concentrated'),
  };

  // All-time combined progress toward the trainee's target, using the
  // Handbook's Combining Fieldwork Types rule (1.3x multiplier on Concentrated
  // hours). Uses raw logged hours across every month, not the per-month
  // adjusted/eligible figure used on the final signed M-FVF/F-FVF — this is a
  // running estimate for the trainee's own dashboard, not a certification
  // document.
  const allTime = await pool.query(
    `SELECT COALESCE(fieldwork_type, 'supervised') AS fieldwork_type, COALESCE(SUM(hours), 0) AS hours
     FROM bcaba_fieldwork_entries WHERE trainee_id = $1 GROUP BY COALESCE(fieldwork_type, 'supervised')`,
    [id]
  );
  const allTimeSupervised = Number(allTime.rows.find(r => r.fieldwork_type === 'supervised')?.hours || 0);
  const allTimeConcentrated = Number(allTime.rows.find(r => r.fieldwork_type === 'concentrated')?.hours || 0);
  const combinedProgress = {
    supervisedHours: allTimeSupervised,
    concentratedHours: allTimeConcentrated,
    ...combinedTotal(allTimeConcentrated, allTimeSupervised),
  };

  res.json({
    entries: rows,
    compliance: overall.compliance,
    adjusted: overall.adjusted,
    summary: overall.summary,
    byType,
    combinedProgress,
  });
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

// GET /bcaba/trainees/:id/supervisors — list every supervisor relationship
// for a trainee (multi-supervisor support). Accessible by the trainee
// themselves, or by any supervisor already listed on this trainee.
router.get('/trainees/:id/supervisors', requireAuth, async (req, res) => {
  const { userId } = req.auth;
  const { id } = req.params;

  const trainee = await pool.query('SELECT user_id FROM bcaba_trainees WHERE id = $1', [id]);
  if (!trainee.rows[0]) return res.status(404).json({ error: 'Trainee not found' });

  const isTrainee = trainee.rows[0].user_id === userId;
  const supervisors = await pool.query(
    `SELECT s.*, vd.file_name AS contract_file_name, vd.file_url AS contract_file_url
     FROM bcaba_supervisors s
     LEFT JOIN vault_documents vd ON vd.id = s.contract_document_id
     WHERE s.trainee_id = $1
     ORDER BY s.is_responsible_supervisor DESC, s.supervisor_name ASC`,
    [id]
  );
  const isListedSupervisor = supervisors.rows.some(s => s.supervisor_user_id === userId);

  if (!isTrainee && !isListedSupervisor) return res.status(403).json({ error: 'Forbidden' });

  const withQualification = supervisors.rows.map((s) => ({ ...s, qualification: computeSupervisorQualification(s) }));
  res.json({ supervisors: withQualification });
});

// PATCH /bcaba/trainees/:id/supervisors/:supervisorId/qualifications — records
// a supervisor's own BCBA certification date and, if in their first year,
// their consulting supervisor's name and most recent consultation date. Same
// Handbook rule as the BCBA-side equivalent (PATCH /supervisors/:id/qualifications).
// Body: { certificationDate, consultingSupervisorName, consultingSupervisorLastConsultationDate }
router.patch('/trainees/:id/supervisors/:supervisorId/qualifications', requireAuth, async (req, res) => {
  const { userId } = req.auth;
  const { id, supervisorId } = req.params;

  const trainee = await pool.query('SELECT user_id FROM bcaba_trainees WHERE id = $1', [id]);
  if (!trainee.rows[0]) return res.status(404).json({ error: 'Trainee not found' });
  const isTrainee = trainee.rows[0].user_id === userId;

  const target = await pool.query(
    'SELECT id FROM bcaba_supervisors WHERE id = $1 AND trainee_id = $2',
    [supervisorId, id]
  );
  if (!target.rows[0]) return res.status(404).json({ error: 'Supervisor not found' });
  const isThisSupervisor = target.rows[0] && (await pool.query(
    'SELECT id FROM bcaba_supervisors WHERE id = $1 AND supervisor_user_id = $2',
    [supervisorId, userId]
  )).rows.length > 0;

  if (!isTrainee && !isThisSupervisor) return res.status(403).json({ error: 'Forbidden' });

  const { certificationDate, consultingSupervisorName, consultingSupervisorLastConsultationDate } = req.body;
  const { rows: [updated] } = await pool.query(
    `UPDATE bcaba_supervisors
     SET supervisor_certification_date = COALESCE($1, supervisor_certification_date),
         consulting_supervisor_name = $2,
         consulting_supervisor_last_consultation_date = $3
     WHERE id = $4
     RETURNING *`,
    [certificationDate || null, consultingSupervisorName || null, consultingSupervisorLastConsultationDate || null, supervisorId]
  );
  res.json({ ...updated, qualification: computeSupervisorQualification(updated) });
});

// POST /bcaba/trainees/:id/supervisors — add an additional (non-responsible)
// supervisor to a trainee. Only the current Responsible Supervisor can add
// contributing supervisors, matching BACB's accountability model.
// Body: { supervisorName, supervisorUserId?, bacbAccountId? }
router.post('/trainees/:id/supervisors', requireAuth, async (req, res) => {
  const { userId } = req.auth;
  const { id } = req.params;
  const { supervisorName, supervisorUserId, bacbAccountId } = req.body;
  if (!supervisorName) return res.status(400).json({ error: 'supervisorName is required' });

  const responsibleCheck = await pool.query(
    'SELECT id FROM bcaba_supervisors WHERE trainee_id = $1 AND supervisor_user_id = $2 AND is_responsible_supervisor = true',
    [id, userId]
  );
  if (responsibleCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Only the Responsible Supervisor can add additional supervisors' });
  }

  const result = await pool.query(
    `INSERT INTO bcaba_supervisors
      (trainee_id, supervisor_user_id, supervisor_name, bacb_account_id, is_responsible_supervisor)
     VALUES ($1, $2, $3, $4, false) RETURNING *`,
    [id, supervisorUserId ?? null, supervisorName, bacbAccountId ?? null]
  );
  res.status(201).json(result.rows[0]);
});

// PATCH /bcaba/trainees/:id/supervisors/:supervisorId/make-responsible
// Reassigns the Responsible Supervisor for a trainee — clears the flag on
// whoever currently holds it and sets it on the target, in one transaction.
router.patch('/trainees/:id/supervisors/:supervisorId/make-responsible', requireAuth, async (req, res) => {
  const { userId } = req.auth;
  const { id, supervisorId } = req.params;

  const responsibleCheck = await pool.query(
    'SELECT id FROM bcaba_supervisors WHERE trainee_id = $1 AND supervisor_user_id = $2 AND is_responsible_supervisor = true',
    [id, userId]
  );
  if (responsibleCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Only the current Responsible Supervisor can reassign this role' });
  }

  const target = await pool.query(
    'SELECT id FROM bcaba_supervisors WHERE id = $1 AND trainee_id = $2',
    [supervisorId, id]
  );
  if (target.rows.length === 0) return res.status(404).json({ error: 'Supervisor not found on this trainee' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE bcaba_supervisors SET is_responsible_supervisor = false WHERE trainee_id = $1',
      [id]
    );
    const updated = await client.query(
      'UPDATE bcaba_supervisors SET is_responsible_supervisor = true WHERE id = $1 RETURNING *',
      [supervisorId]
    );
    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH make-responsible error:', err);
    res.status(500).json({ error: 'Failed to reassign Responsible Supervisor' });
  } finally {
    client.release();
  }
});

// PATCH /bcaba/trainees/:id/supervisors/:supervisorId/contract
// Attaches a supervision contract document (already uploaded via
// POST /vault/upload with category 'supervision_contract') to a specific
// supervisor relationship. A supervisor may only attach a contract to their
// own row — the vault document must also belong to their own account,
// matching the same "contracts live in the uploading supervisor's vault"
// convention used on the BCBA side.
// Body: { vaultDocumentId, contractSignedDate }
router.patch('/trainees/:id/supervisors/:supervisorId/contract', requireAuth, async (req, res) => {
  const { userId } = req.auth;
  const { id, supervisorId } = req.params;
  const { vaultDocumentId, contractSignedDate } = req.body;
  if (!vaultDocumentId) return res.status(400).json({ error: 'vaultDocumentId is required' });

  const supervisorRow = await pool.query(
    'SELECT id FROM bcaba_supervisors WHERE id = $1 AND trainee_id = $2 AND supervisor_user_id = $3',
    [supervisorId, id, userId]
  );
  if (supervisorRow.rows.length === 0) {
    return res.status(403).json({ error: 'You can only attach a contract to your own supervisor record' });
  }

  const professional = await getProfessionalRole(userId);
  if (!professional) return res.status(403).json({ error: 'Forbidden' });

  const doc = await pool.query(
    'SELECT id FROM vault_documents WHERE id = $1 AND professional_id = $2',
    [vaultDocumentId, professional.id]
  );
  if (doc.rows.length === 0) return res.status(404).json({ error: 'Document not found in your vault' });

  const updated = await pool.query(
    `UPDATE bcaba_supervisors
     SET contract_document_id = $1, contract_signed_date = COALESCE($2, contract_signed_date)
     WHERE id = $3
     RETURNING *`,
    [vaultDocumentId, contractSignedDate || null, supervisorId]
  );
  res.json(updated.rows[0]);
});

// PATCH /bcaba/trainees/:id/supervisors/:supervisorId/training
// Records the date a supervisor completed the BACB-required 8-hour
// Supervisor Training. A supervisor may only set this on their own row.
// Body: { trainingDate }
router.patch('/trainees/:id/supervisors/:supervisorId/training', requireAuth, async (req, res) => {
  const { userId } = req.auth;
  const { id, supervisorId } = req.params;
  const { trainingDate } = req.body;
  if (!trainingDate) return res.status(400).json({ error: 'trainingDate is required' });

  const supervisorRow = await pool.query(
    'SELECT id FROM bcaba_supervisors WHERE id = $1 AND trainee_id = $2 AND supervisor_user_id = $3',
    [supervisorId, id, userId]
  );
  if (supervisorRow.rows.length === 0) {
    return res.status(403).json({ error: 'You can only record training for your own supervisor record' });
  }

  const updated = await pool.query(
    `UPDATE bcaba_supervisors SET supervisor_training_date = $1 WHERE id = $2 RETURNING *`,
    [trainingDate, supervisorId]
  );
  res.json(updated.rows[0]);
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