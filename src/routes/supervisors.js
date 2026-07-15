import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { computeSupervisorQualification } from './supervisor-qualifications.js';

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

export default router;