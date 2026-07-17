import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { computeSupervisorQualification } from './supervisor-qualifications.js';
import { calcCompliance } from '../services/compliance.js';

const router = Router();

// GET /supervisors — list the logged-in trainee's own BCBA-side supervisor
// records, including contract status and computed qualification status (per
// the Handbook's Supervisor Qualifications rule: certified <1 year requires
// an active, currently-consulted consulting supervisor relationship).
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1',
      [req.auth.userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { rows } = await pool.query(
      `SELECT s.*, vd.file_name AS contract_file_name, vd.file_url AS contract_file_url
       FROM supervisors s
       LEFT JOIN vault_documents vd ON vd.id = s.contract_document_id
       WHERE s.professional_id = $1
       ORDER BY s.is_responsible DESC, s.supervisor_name ASC`,
      [pro.id]
    );
    const withQualification = rows.map((s) => ({ ...s, qualification: computeSupervisorQualification(s) }));
    res.json({ supervisors: withQualification });
  } catch (err) {
    console.error('GET /supervisors error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /supervisors/:id/qualifications — records a supervisor's own BCBA
// certification date and, if they're in their first year of certification,
// their consulting supervisor's name and the date of their most recent
// monthly consultation. Per Handbook Supervisor Qualifications: a supervisor
// certified less than one year must receive monthly consultation from a
// qualified consulting supervisor to be eligible to provide fieldwork
// supervision at all.
// Body: { certificationDate, consultingSupervisorName, consultingSupervisorLastConsultationDate }
router.patch('/:id/qualifications', requireAuth, async (req, res) => {
  try {
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1',
      [req.auth.userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { certificationDate, consultingSupervisorName, consultingSupervisorLastConsultationDate } = req.body;

    const { rows: [existingSupervisor] } = await pool.query(
      'SELECT id FROM supervisors WHERE id = $1 AND professional_id = $2',
      [req.params.id, pro.id]
    );
    if (!existingSupervisor) return res.status(404).json({ error: 'Supervisor not found' });

    const { rows: [updated] } = await pool.query(
      `UPDATE supervisors
       SET supervisor_certification_date = COALESCE($1, supervisor_certification_date),
           consulting_supervisor_name = $2,
           consulting_supervisor_last_consultation_date = $3
       WHERE id = $4
       RETURNING *`,
      [certificationDate || null, consultingSupervisorName || null, consultingSupervisorLastConsultationDate || null, req.params.id]
    );
    res.json({ ...updated, qualification: computeSupervisorQualification(updated) });
  } catch (err) {
    console.error('PATCH /supervisors/:id/qualifications error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /supervisors/:id/contract — attach a supervision contract document
// (already uploaded via POST /vault/upload with category 'supervision_contract')
// to a supervisor record. The document must belong to the same trainee's
// vault — contracts live in the trainee's vault since that's the account
// making this request, even though a real supervision contract concerns
// both parties.
// Body: { vaultDocumentId, contractSignedDate }
router.patch('/:id/contract', requireAuth, async (req, res) => {
  try {
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1',
      [req.auth.userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { vaultDocumentId, contractSignedDate } = req.body;
    if (!vaultDocumentId) return res.status(400).json({ error: 'vaultDocumentId is required' });

    const { rows: [existingSupervisor] } = await pool.query(
      'SELECT id FROM supervisors WHERE id = $1 AND professional_id = $2',
      [req.params.id, pro.id]
    );
    if (!existingSupervisor) return res.status(404).json({ error: 'Supervisor not found' });

    const { rows: [doc] } = await pool.query(
      'SELECT id FROM vault_documents WHERE id = $1 AND professional_id = $2',
      [vaultDocumentId, pro.id]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found in your vault' });

    const { rows: [updated] } = await pool.query(
      `UPDATE supervisors
       SET contract_document_id = $1, supervision_start_date = COALESCE($2, supervision_start_date)
       WHERE id = $3
       RETURNING *`,
      [vaultDocumentId, contractSignedDate || null, req.params.id]
    );
    res.json(updated);
  } catch (err) {
    console.error('PATCH /supervisors/:id/contract error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /supervisors/:id/training — records the date a supervisor completed
// the BACB-required 8-hour Supervisor Training (based on the Supervisor
// Training Curriculum Outline 2.0), which must be completed before they can
// provide fieldwork supervision. Unlike a contract, no document upload is
// required — the date itself is the compliance-relevant fact.
// Body: { trainingDate }
router.patch('/:id/training', requireAuth, async (req, res) => {
  try {
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1',
      [req.auth.userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { trainingDate } = req.body;
    if (!trainingDate) return res.status(400).json({ error: 'trainingDate is required' });

    const { rows: [existingSupervisor] } = await pool.query(
      'SELECT id FROM supervisors WHERE id = $1 AND professional_id = $2',
      [req.params.id, pro.id]
    );
    if (!existingSupervisor) return res.status(404).json({ error: 'Supervisor not found' });

    const { rows: [updated] } = await pool.query(
      `UPDATE supervisors SET supervisor_training_date = $1 WHERE id = $2 RETURNING *`,
      [trainingDate, req.params.id]
    );
    res.json(updated);
  } catch (err) {
    console.error('PATCH /supervisors/:id/training error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /supervisors/:id/make-responsible
// Reassigns the Responsible Supervisor for the logged-in trainee — clears
// the flag on whoever currently holds it and sets it on the target, in one
// transaction. Mirrors the same pattern used on the BCaBA side.
router.patch('/:id/make-responsible', requireAuth, async (req, res) => {
  try {
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1',
      [req.auth.userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { rows: [target] } = await pool.query(
      'SELECT id FROM supervisors WHERE id = $1 AND professional_id = $2',
      [req.params.id, pro.id]
    );
    if (!target) return res.status(404).json({ error: 'Supervisor not found' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE supervisors SET is_responsible = false WHERE professional_id = $1',
        [pro.id]
      );
      const { rows: [updated] } = await client.query(
        'UPDATE supervisors SET is_responsible = true WHERE id = $1 RETURNING *',
        [req.params.id]
      );
      await client.query('COMMIT');
      res.json(updated);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('PATCH /supervisors/:id/make-responsible error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /supervisors/:id/link — links a supervisor record to a real Supervisd
// account by email, so that account can independently view and sign this
// trainee's M-FVF/F-FVF as the supervisor, rather than the trainee capturing
// both signatures themselves. Mirrors bcaba_supervisors.supervisor_user_id.
// Only the trainee who owns this supervisor record can link it.
// Body: { email }
router.patch('/:id/link', requireAuth, async (req, res) => {
  try {
    const { rows: [pro] } = await pool.query(
      'SELECT id, email FROM professionals WHERE clerk_user_id = $1',
      [req.auth.userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    // Compare by email, not clerk_user_id -- a single email can have more than
    // one professionals row under different clerk_user_ids (e.g. stale
    // duplicate/test accounts), so a clerk_user_id-only check can miss a
    // genuine self-link attempt if the lookup happens to resolve a different
    // duplicate row than the caller's own.
    if (pro.email && email && pro.email.toLowerCase() === email.toLowerCase()) {
      return res.status(400).json({ error: 'You cannot link yourself as your own supervisor' });
    }

    const { rows: [existingSupervisor] } = await pool.query(
      'SELECT id FROM supervisors WHERE id = $1 AND professional_id = $2',
      [req.params.id, pro.id]
    );
    if (!existingSupervisor) return res.status(404).json({ error: 'Supervisor not found' });

    const { rows: [account] } = await pool.query(
      'SELECT clerk_user_id, full_name FROM professionals WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    if (!account) return res.status(404).json({ error: 'No Supervisd account found for that email. They need to sign up before you can link them.' });
    if (account.clerk_user_id === req.auth.userId) return res.status(400).json({ error: 'You cannot link yourself as your own supervisor' });

    const { rows: [updated] } = await pool.query(
      `UPDATE supervisors SET supervisor_user_id = $1 WHERE id = $2 RETURNING *`,
      [account.clerk_user_id, req.params.id]
    );
    res.json({ ...updated, qualification: computeSupervisorQualification(updated), linked_account_name: account.full_name });
  } catch (err) {
    console.error('PATCH /supervisors/:id/link error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /supervisors/:id/unlink — reverses a link, reverting to the
// trainee-captures-both-signatures fallback. Only the trainee who owns this
// supervisor record can unlink it.
router.patch('/:id/unlink', requireAuth, async (req, res) => {
  try {
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1',
      [req.auth.userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { rows: [existingSupervisor] } = await pool.query(
      'SELECT id FROM supervisors WHERE id = $1 AND professional_id = $2',
      [req.params.id, pro.id]
    );
    if (!existingSupervisor) return res.status(404).json({ error: 'Supervisor not found' });

    const { rows: [updated] } = await pool.query(
      `UPDATE supervisors SET supervisor_user_id = NULL WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    res.json({ ...updated, qualification: computeSupervisorQualification(updated) });
  } catch (err) {
    console.error('PATCH /supervisors/:id/unlink error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /supervisors/my-trainees — for a certified BCBA whose account has been
// linked (via PATCH /:id/link above) as the named supervisor on one or more
// trainees' fieldwork. Mirrors GET /bcaba/supervisor/trainees.
router.get('/my-trainees', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id AS supervisor_record_id, s.professional_id, s.is_responsible,
              p.full_name, p.credential_number, p.bcba_supervision_track, p.fieldwork_start_date
       FROM supervisors s
       JOIN professionals p ON p.id = s.professional_id
       WHERE s.supervisor_user_id = $1
       ORDER BY p.full_name ASC`,
      [req.auth.userId]
    );
    res.json({ trainees: rows });
  } catch (err) {
    console.error('GET /supervisors/my-trainees error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /supervisors/my-trainees — supervisor-initiated linkage. Attaches an
// existing trainee account to the calling BCBA supervisor by email: creates a
// supervisors record on the TRAINEE's account, pre-linked to this supervisor
// (supervisor_user_id), so it appears immediately under GET /my-trainees and
// the trainee sees this supervisor in their Fieldwork Supervisors panel.
// This is the inverse of the trainee-initiated PATCH /:id/link flow. It grants
// visibility only; M-FVF/F-FVF signatures remain per-party identity-verified,
// so a supervisor still cannot forge a trainee's signature. Mirrors the BCaBA
// add-by-email flow (POST /bcaba/trainees). Body: { traineeEmail }
router.post('/my-trainees', requireAuth, async (req, res) => {
  try {
    const { rows: [me] } = await pool.query(
      'SELECT id, email, full_name, credential_number FROM professionals WHERE clerk_user_id = $1',
      [req.auth.userId]
    );
    if (!me) return res.status(404).json({ error: 'Professional not found' });

    const { traineeEmail } = req.body;
    if (!traineeEmail || !traineeEmail.trim()) {
      return res.status(400).json({ error: 'traineeEmail is required' });
    }
    const email = traineeEmail.trim();

    // Self-add guard (by email and by clerk id), mirroring the link handler.
    if (me.email && me.email.toLowerCase() === email.toLowerCase()) {
      return res.status(400).json({ error: 'You cannot add yourself as your own trainee' });
    }

    const { rows: [trainee] } = await pool.query(
      'SELECT id, clerk_user_id, full_name FROM professionals WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    if (!trainee) {
      return res.status(404).json({ error: 'No Supervisd account found for that email. They need to sign up before you can add them.' });
    }
    if (trainee.clerk_user_id === req.auth.userId) {
      return res.status(400).json({ error: 'You cannot add yourself as your own trainee' });
    }

    // Idempotent: if this supervisor is already linked to this trainee, return it.
    const { rows: [already] } = await pool.query(
      `SELECT id AS supervisor_record_id, professional_id, is_responsible
         FROM supervisors
        WHERE professional_id = $1 AND supervisor_user_id = $2`,
      [trainee.id, req.auth.userId]
    );
    if (already) {
      return res.json({ trainee: { ...already, full_name: trainee.full_name }, alreadyLinked: true });
    }

    // The first supervisor on a trainee's fieldwork defaults to Responsible.
    const { rows: [countRow] } = await pool.query(
      'SELECT COUNT(*) FROM supervisors WHERE professional_id = $1',
      [trainee.id]
    );
    const isFirst = Number(countRow.count) === 0;

    const { rows: [created] } = await pool.query(
      `INSERT INTO supervisors (professional_id, supervisor_name, supervisor_credential, supervisor_user_id, is_responsible)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id AS supervisor_record_id, professional_id, is_responsible`,
      [trainee.id, me.full_name || 'Supervisor', me.credential_number || null, req.auth.userId, isFirst]
    );
    res.json({ trainee: { ...created, full_name: trainee.full_name } });
  } catch (err) {
    console.error('POST /supervisors/my-trainees error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /supervisors/trainee-status — per-BCBA-trainee current-month compliance
// snapshot for the supervisor dashboard. Reuses calcCompliance. "At risk" is
// deliberately conservative: only flagged when the trainee HAS logged hours
// this month but the month isn't meeting supervision/observation/contact
// requirements, so a trainee who simply hasn't started the month doesn't
// false-alarm. BCBA trainees only for now (BCaBA uses a separate model).
router.get('/trainee-status', requireAuth, async (req, res) => {
  try {
    const me = req.auth.userId;
    const { rows: trainees } = await pool.query(
      `SELECT DISTINCT p.id, p.full_name, p.bcba_supervision_track, p.fieldwork_start_date
         FROM supervisors s JOIN professionals p ON p.id = s.professional_id
        WHERE s.supervisor_user_id = $1`,
      [me]
    );
    const currentMonth = new Date().toISOString().slice(0, 7);
    const out = [];
    for (const t of trainees) {
      try {
        const { rows: entries } = await pool.query(
          'SELECT * FROM fieldwork_entries WHERE professional_id = $1', [t.id]
        );
        const c = calcCompliance(entries, t.bcba_supervision_track || 'supervised', t.fieldwork_start_date);
        const cm = (c.monthlyBreakdown || []).find(m => m.month === currentMonth);
        const hoursThisMonth = cm?.rawHours ?? 0;
        const reasons = [];
        if (hoursThisMonth > 0) {
          if (!c.supervisionMet) reasons.push('supervision below minimum');
          if (!c.monthlyObservationMet) reasons.push('observation missing');
          if (c.contactsMet === false) reasons.push('contacts below minimum');
        }
        const eligible = c.totalEligibleHours ?? 0;
        const target = c.totalHoursRequired ?? 2000;
        out.push({
          professional_id: t.id,
          full_name: t.full_name,
          track: t.bcba_supervision_track || 'supervised',
          totalHours: c.totalHours ?? 0,
          totalEligibleHours: eligible,
          totalHoursRequired: target,
          pctComplete: target > 0 ? Math.round((eligible / target) * 1000) / 10 : 0,
          supervisionPct: c.supervisionPct ?? 0,
          supervisionMet: !!c.supervisionMet,
          restrictedPct: c.restrictedPct ?? 0,
          restrictedMet: c.restrictedMet !== false,
          hoursThisMonth,
          monthState: hoursThisMonth === 0 ? 'not_started' : (reasons.length > 0 ? 'at_risk' : 'on_track'),
          atRisk: reasons.length > 0,
          reasons,
          fieldworkDeadline: c.fieldworkDeadline ?? null,
        });
      } catch (e) {
        out.push({ professional_id: t.id, full_name: t.full_name, error: true });
      }
    }
    res.json({ trainees: out });
  } catch (err) {
    console.error('GET /supervisors/trainee-status error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;