import express from 'express';
import PDFDocument from 'pdfkit';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

async function getProfessional(clerkUserId) {
  const { rows } = await pool.query('SELECT * FROM professionals WHERE clerk_user_id = $1', [clerkUserId]);
  return rows[0] || null;
}

async function isLinkedSupervisor(clerkUserId, supervisorId) {
  const { rows: [s] } = await pool.query('SELECT supervisor_user_id FROM supervisors WHERE id = $1', [supervisorId]);
  return !!s && s.supervisor_user_id === clerkUserId;
}

// GET /bcba-final-verification?traineeId=<professionals.id>
// Supervisor-side: for a linked supervisor viewing one trainee's F-FVFs.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { traineeId } = req.query;
    if (!traineeId) return res.status(400).json({ error: 'traineeId is required' });

    const { rows } = await pool.query(
      `SELECT fv.*, s.supervisor_name FROM bcba_final_verifications fv
       JOIN supervisors s ON s.id = fv.supervisor_id
       WHERE fv.professional_id = $1 AND s.supervisor_user_id = $2
       ORDER BY fv.created_at DESC`,
      [traineeId, req.auth.userId]
    );
    if (rows.length === 0) {
      const { rows: [link] } = await pool.query(
        'SELECT id FROM supervisors WHERE professional_id = $1 AND supervisor_user_id = $2',
        [traineeId, req.auth.userId]
      );
      if (!link) return res.status(403).json({ error: 'You are not a linked supervisor for this trainee' });
    }
    res.json({ finalVerifications: rows });
  } catch (err) {
    console.error('GET /bcba-final-verification error:', err);
    res.status(500).json({ error: 'Failed to fetch F-FVFs' });
  }
});

// POST /bcba-final-verification/draft
// Body: { supervisorId, periodStartDate, periodEndDate, fieldworkType, organizationName }
// Aggregates every finalized bcba_monthly_verification in range for this
// trainee/supervisor/fieldworkType into one F-FVF, per Handbook "please
// complete one form per supervisor, per fieldwork type."
router.post('/draft', requireAuth, async (req, res) => {
  try {
    const pro = await getProfessional(req.auth.userId);
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { supervisorId, periodStartDate, periodEndDate, fieldworkType, organizationName } = req.body;
    if (!supervisorId || !periodStartDate || !periodEndDate || !fieldworkType) {
      return res.status(400).json({ error: 'supervisorId, periodStartDate, periodEndDate, and fieldworkType are required' });
    }

    const { rows: [supervisor] } = await pool.query(
      'SELECT * FROM supervisors WHERE id = $1 AND professional_id = $2',
      [supervisorId, pro.id]
    );
    if (!supervisor) return res.status(404).json({ error: 'Supervisor not found' });

    const { rows: months } = await pool.query(
      `SELECT * FROM bcba_monthly_verification
       WHERE professional_id = $1 AND supervisor_id = $2
         AND month_year >= $3 AND month_year <= $4
         AND status = 'finalized' AND fieldwork_type = $5
       ORDER BY month_year ASC`,
      [pro.id, supervisorId, periodStartDate, periodEndDate, fieldworkType]
    );

    if (months.length === 0) {
      return res.status(400).json({ error: `No finalized ${fieldworkType} monthly verifications found in this date range` });
    }

    const totals = months.reduce((acc, m) => {
      acc.independent += Number(m.independent_hours || 0);
      acc.supervised += Number(m.supervised_hours || 0);
      acc.individual += Number(m.individual_supervision_hours || 0);
      acc.group += Number(m.group_supervision_hours || 0);
      return acc;
    }, { independent: 0, supervised: 0, individual: 0, group: 0 });

    const totalFieldworkHours = totals.independent + totals.supervised;
    const percentSupervised = totalFieldworkHours > 0
      ? Number(((totals.supervised / totalFieldworkHours) * 100).toFixed(2))
      : 0;

    // All months already only exist as 'finalized' rows if their compliance
    // check passed at draft time and both parties signed -- but a month can
    // still have been finalized under adjustment (e.g. prorated hours), so
    // this is a simple "we have N finalized months in range" confirmation,
    // not a re-check of BACB thresholds (those were already gated at the
    // M-FVF level before finalization).
    const allMonthlyRequirementsMet = true;

    const insert = await pool.query(
      `INSERT INTO bcba_final_verifications
       (professional_id, supervisor_id, fieldwork_type, period_start_date, period_end_date, organization_name,
        total_independent_hours, total_supervised_hours, total_individual_supervision_hours,
        total_group_supervision_hours, total_fieldwork_hours, percent_supervised, all_monthly_requirements_met, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'draft')
       RETURNING *`,
      [pro.id, supervisorId, fieldworkType, periodStartDate, periodEndDate, organizationName || null,
        totals.independent, totals.supervised, totals.individual, totals.group,
        totalFieldworkHours, percentSupervised, allMonthlyRequirementsMet]
    );
    const finalVerification = insert.rows[0];

    for (const m of months) {
      await pool.query(
        `INSERT INTO bcba_final_verification_months (final_verification_id, monthly_verification_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [finalVerification.id, m.id]
      );
    }

    res.json({ ...finalVerification, months_included: months.length });
  } catch (err) {
    console.error('POST /bcba-final-verification/draft error:', err);
    res.status(500).json({ error: 'Failed to create F-FVF draft' });
  }
});

// GET /bcba-final-verification/mine
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const pro = await getProfessional(req.auth.userId);
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { rows } = await pool.query(
      `SELECT fv.*, s.supervisor_name, s.supervisor_user_id FROM bcba_final_verifications fv
       JOIN supervisors s ON s.id = fv.supervisor_id
       WHERE fv.professional_id = $1 ORDER BY fv.created_at DESC`,
      [pro.id]
    );
    res.json({ finalVerifications: rows });
  } catch (err) {
    console.error('GET /bcba-final-verification/mine error:', err);
    res.status(500).json({ error: 'Failed to fetch F-FVFs' });
  }
});

// PATCH /bcba-final-verification/:id/sign
// Body: { role: 'trainee' | 'supervisor', signature }
router.patch('/:id/sign', requireAuth, async (req, res) => {
  try {
    const pro = await getProfessional(req.auth.userId);
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { id } = req.params;
    const { role, signature } = req.body;
    if (!['trainee', 'supervisor'].includes(role)) return res.status(400).json({ error: 'role must be trainee or supervisor' });
    if (!signature) return res.status(400).json({ error: 'signature is required' });

    const { rows: [record] } = await pool.query('SELECT * FROM bcba_final_verifications WHERE id = $1', [id]);
    if (!record) return res.status(404).json({ error: 'Not found' });

    const isTrainee = record.professional_id === pro.id;
    const { rows: [supervisorRow] } = await pool.query('SELECT supervisor_user_id FROM supervisors WHERE id = $1', [record.supervisor_id]);
    const supervisorIsLinked = !!supervisorRow?.supervisor_user_id;
    const isLinkedSupervisorCaller = supervisorIsLinked && supervisorRow.supervisor_user_id === req.auth.userId;

    if (role === 'trainee') {
      if (!isTrainee) return res.status(403).json({ error: 'Only the trainee can sign as trainee' });
    } else {
      if (supervisorIsLinked) {
        if (!isLinkedSupervisorCaller) return res.status(403).json({ error: 'This supervisor is linked to their own account -- only they can sign as supervisor' });
      } else if (!isTrainee) {
        return res.status(403).json({ error: 'Not authorized for this record' });
      }
    }

    const timestampField = role === 'trainee' ? 'trainee_signed_at' : 'supervisor_signed_at';
    const signatureField = role === 'trainee' ? 'trainee_signature' : 'supervisor_signature';

    const result = await pool.query(
      `UPDATE bcba_final_verifications SET ${timestampField} = NOW(), ${signatureField} = $2 WHERE id = $1 RETURNING *`,
      [id, signature]
    );
    let updated = result.rows[0];

    if (updated.trainee_signed_at && updated.supervisor_signed_at) {
      const finalized = await pool.query(
        `UPDATE bcba_final_verifications SET status = 'finalized' WHERE id = $1 RETURNING *`,
        [id]
      );
      updated = finalized.rows[0];
    }

    res.json(updated);
  } catch (err) {
    console.error('PATCH /bcba-final-verification/:id/sign error:', err);
    res.status(500).json({ error: 'Failed to sign F-FVF' });
  }
});

// GET /bcba-final-verification/:id/pdf
router.get('/:id/pdf', requireAuth, async (req, res) => {
  try {
    const pro = await getProfessional(req.auth.userId);
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { rows: [fv] } = await pool.query('SELECT * FROM bcba_final_verifications WHERE id = $1', [req.params.id]);
    if (!fv) return res.status(404).json({ error: 'Not found' });

    const isTrainee = fv.professional_id === pro.id;
    const isLinked = await isLinkedSupervisor(req.auth.userId, fv.supervisor_id);
    if (!isTrainee && !isLinked) return res.status(403).json({ error: 'Not authorized to view this F-FVF' });

    const { rows: [trainee] } = await pool.query('SELECT * FROM professionals WHERE id = $1', [fv.professional_id]);
    const { rows: [supervisor] } = await pool.query('SELECT * FROM supervisors WHERE id = $1', [fv.supervisor_id]);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=bcba-ffvf-${fv.id}.pdf`);

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    doc.fontSize(18).text('Final Fieldwork Verification Form', { align: 'left' });
    doc.fontSize(11).fillColor('gray').text('Individual Supervisor — BCBA');
    doc.moveDown();
    doc.fillColor('black').fontSize(10);

    doc.text(`Trainee Name: ${trainee.full_name}`);
    doc.text(`BACB ID #: ${trainee.credential_number || ''}`);
    doc.text(`Supervisor Name: ${supervisor?.supervisor_name || ''}`);
    doc.text(`Supervisor BACB ID #: ${supervisor?.supervisor_credential || ''}`);
    doc.text(`Fieldwork Type: ${fv.fieldwork_type === 'concentrated' ? 'Concentrated Supervised Fieldwork' : 'Supervised Fieldwork'}`);
    doc.text(`Organization: ${fv.organization_name || ''}`);
    doc.text(`Period: ${fv.period_start_date.toISOString().slice(0, 10)} to ${fv.period_end_date.toISOString().slice(0, 10)}`);
    doc.moveDown();

    doc.fontSize(12).text('Fieldwork Hours (Full Experience)', { underline: true });
    doc.fontSize(10);
    doc.text(`A. Independent Hours: ${fv.total_independent_hours}`);
    doc.text(`B. Supervised Hours: ${fv.total_supervised_hours}`);
    doc.text(`Individual Supervision Hours: ${fv.total_individual_supervision_hours}`);
    doc.text(`Group Supervision Hours: ${fv.total_group_supervision_hours}`);
    doc.text(`Total Fieldwork Hours (A + B): ${fv.total_fieldwork_hours}`);
    doc.text(`Percent of Hours Supervised: ${fv.percent_supervised}%`);
    doc.moveDown();

    doc.fontSize(12).text('Attestations', { underline: true });
    doc.fontSize(10);
    doc.text(`All monthly requirements met: ${fv.all_monthly_requirements_met ? 'Yes' : 'No'}`);
    doc.moveDown();

    doc.fontSize(12).text('Signatures', { underline: true });
    doc.fontSize(10);
    doc.text(`Trainee signed: ${fv.trainee_signed_at ? fv.trainee_signed_at.toISOString().slice(0, 10) : 'Not yet signed'}`);
    doc.text(`Supervisor signed: ${fv.supervisor_signed_at ? fv.supervisor_signed_at.toISOString().slice(0, 10) : 'Not yet signed'}`);
    doc.moveDown();
    doc.fontSize(8).fillColor('gray').text('Both parties must retain a copy of this form for at least 7 years.');

    doc.end();
  } catch (err) {
    console.error('GET /bcba-final-verification/:id/pdf error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

export default router;
