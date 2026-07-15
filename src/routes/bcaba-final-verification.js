import express from 'express';
import PDFDocument from 'pdfkit';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { checkMonthlyCompliance, buildFinalVerification } from './bcaba-rules.js';

const router = express.Router();

async function loadTraineeAndSupervisor(traineeId, supervisorId) {
  const { rows: traineeRows } = await pool.query(
    'SELECT * FROM bcaba_trainees WHERE id = $1',
    [traineeId]
  );
  const { rows: supervisorRows } = await pool.query(
    'SELECT * FROM bcaba_supervisors WHERE id = $1 AND trainee_id = $2',
    [supervisorId, traineeId]
  );
  return { trainee: traineeRows[0] || null, supervisor: supervisorRows[0] || null };
}

// GET /bcaba-final-verification/mine
// Returns all F-FVFs where the requesting user is either the trainee or the supervisor
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { rows } = await pool.query(
      `SELECT fv.* FROM bcaba_final_verifications fv
       JOIN bcaba_trainees t ON t.id = fv.trainee_id
       JOIN bcaba_supervisors s ON s.id = fv.supervisor_id
       WHERE t.user_id = $1 OR s.supervisor_user_id = $1
       ORDER BY fv.created_at DESC`,
      [userId]
    );
    res.json({ finalVerifications: rows });
  } catch (err) {
    console.error('Error fetching F-FVFs:', err);
    res.status(500).json({ error: 'Failed to fetch F-FVFs' });
  }
});

// GET /bcaba-final-verification/supervisors
// Returns the supervisor(s) available to the current trainee, for the F-FVF picker
router.get('/supervisors', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { rows } = await pool.query(
      `SELECT s.id AS supervisor_id, s.supervisor_name, s.trainee_id, t.fieldwork_type
       FROM bcaba_supervisors s
       JOIN bcaba_trainees t ON t.id = s.trainee_id
       WHERE t.user_id = $1
       ORDER BY s.supervisor_name ASC`,
      [userId]
    );
    res.json({ supervisors: rows });
  } catch (err) {
    console.error('Error fetching supervisors for F-FVF:', err);
    res.status(500).json({ error: 'Failed to fetch supervisors' });
  }
});

router.post('/draft', requireAuth, async (req, res) => {
  try {
    const { trainee_id, supervisor_id, period_start_date, period_end_date, form_type, organization_name, fieldwork_type: requestedFieldworkType } = req.body;

    if (!trainee_id || !supervisor_id || !period_start_date || !period_end_date || !form_type) {
      return res.status(400).json({ error: 'trainee_id, supervisor_id, period_start_date, period_end_date, and form_type are required' });
    }

    const { trainee, supervisor } = await loadTraineeAndSupervisor(trainee_id, supervisor_id);
    if (!trainee || !supervisor) {
      return res.status(404).json({ error: 'Trainee or supervisor relationship not found' });
    }

    const { userId } = req.auth;
    if (trainee.user_id !== userId && supervisor.supervisor_user_id !== userId) {
      return res.status(403).json({ error: 'Not authorized for this trainee/supervisor relationship' });
    }

    // fieldwork_type disambiguates which track this F-FVF covers. Required now
    // that a trainee can have both a Supervised and a Concentrated finalized
    // monthly verification for the same month — mixing them into one F-FVF
    // would combine two different rule sets' months into a single form, which
    // the Handbook doesn't allow ("Please complete one form per supervisor,
    // per fieldwork type"). Defaults to the trainee's primary track when
    // omitted, preserving prior behavior for trainees who never mix types.
    const fieldworkType = requestedFieldworkType || trainee.fieldwork_type;

    const { rows: months } = await pool.query(
      `SELECT * FROM bcaba_monthly_verification
       WHERE trainee_id = $1 AND supervisor_id = $2
         AND month_year >= $3 AND month_year <= $4
         AND status = 'finalized'
         AND COALESCE(fieldwork_type, 'supervised') = $5
       ORDER BY month_year ASC`,
      [trainee_id, supervisor_id, period_start_date, period_end_date, fieldworkType]
    );

    if (months.length === 0) {
      return res.status(400).json({ error: `No finalized ${fieldworkType} monthly verifications found in this date range for this trainee/supervisor` });
    }

    const mapped = months.map((m) => {
      const totalHours = Number(m.independent_hours || 0) + Number(m.supervised_hours || 0);
      const compliance = checkMonthlyCompliance({
        fieldworkType,
        totalHours,
        contactsCount: m.contacts_count,
        observationCompleted: m.observation_completed,
        individualHours: Number(m.individual_supervision_hours || 0),
        groupHours: Number(m.group_supervision_hours || 0),
        supervisedHours: Number(m.supervised_hours || 0),
      });

      return {
        id: m.id,
        independentHours: m.independent_hours,
        supervisedHours: m.supervised_hours,
        individualSupervisionHours: m.individual_supervision_hours,
        groupSupervisionHours: m.group_supervision_hours,
        complianceMet: compliance.compliant,
      };
    });

    const agg = buildFinalVerification(mapped);
    if (agg.error) {
      return res.status(400).json({ error: agg.error });
    }

    const insertResult = await pool.query(
      `INSERT INTO bcaba_final_verifications (
        trainee_id, supervisor_id, form_type, fieldwork_type,
        period_start_date, period_end_date, organization_name,
        total_independent_hours, total_supervised_hours,
        total_individual_supervision_hours, total_group_supervision_hours,
        total_fieldwork_hours, percent_supervised, all_monthly_requirements_met,
        status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft')
      RETURNING *`,
      [
        trainee_id, supervisor_id, form_type, fieldworkType,
        period_start_date, period_end_date, organization_name || null,
        agg.total_independent_hours, agg.total_supervised_hours,
        agg.total_individual_supervision_hours, agg.total_group_supervision_hours,
        agg.total_fieldwork_hours, agg.percent_supervised, agg.all_monthly_requirements_met,
      ]
    );

    const finalVerification = insertResult.rows[0];

    for (const monthId of agg.monthly_verification_ids) {
      await pool.query(
        `INSERT INTO bcaba_final_verification_months (final_verification_id, monthly_verification_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [finalVerification.id, monthId]
      );
    }

    res.json({ ...finalVerification, months_included: agg.months_included });
  } catch (err) {
    console.error('Error creating F-FVF draft:', err);
    res.status(500).json({ error: 'Failed to create F-FVF draft' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM bcaba_final_verifications WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const finalVerification = rows[0];
    const { trainee, supervisor } = await loadTraineeAndSupervisor(
      finalVerification.trainee_id,
      finalVerification.supervisor_id
    );

    const { userId } = req.auth;
    if (trainee.user_id !== userId && supervisor.supervisor_user_id !== userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { rows: months } = await pool.query(
      `SELECT mv.* FROM bcaba_monthly_verification mv
       JOIN bcaba_final_verification_months fvm ON fvm.monthly_verification_id = mv.id
       WHERE fvm.final_verification_id = $1
       ORDER BY mv.month_year ASC`,
      [finalVerification.id]
    );

    res.json({ ...finalVerification, trainee, supervisor, included_months: months });
  } catch (err) {
    console.error('Error fetching F-FVF:', err);
    res.status(500).json({ error: 'Failed to fetch F-FVF' });
  }
});

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bcaba_final_verifications WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const existing = rows[0];

    const { trainee, supervisor } = await loadTraineeAndSupervisor(existing.trainee_id, existing.supervisor_id);
    const { userId } = req.auth;
    if ((!trainee || trainee.user_id !== userId) && (!supervisor || supervisor.supervisor_user_id !== userId)) {
      return res.status(403).json({ error: 'Not authorized for this F-FVF' });
    }

    if (existing.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft F-FVFs can be edited' });
    }

    const {
      organization_name,
      supervisor_qualified_entire_duration,
      supervisor_completed_8hr_training,
      supervisor_designated_in_contract,
      included_prorated_hours,
    } = req.body;

    const updated = await pool.query(
      `UPDATE bcaba_final_verifications SET
        organization_name = COALESCE($1, organization_name),
        supervisor_qualified_entire_duration = COALESCE($2, supervisor_qualified_entire_duration),
        supervisor_completed_8hr_training = COALESCE($3, supervisor_completed_8hr_training),
        supervisor_designated_in_contract = COALESCE($4, supervisor_designated_in_contract),
        included_prorated_hours = COALESCE($5, included_prorated_hours),
        updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        organization_name, supervisor_qualified_entire_duration,
        supervisor_completed_8hr_training, supervisor_designated_in_contract,
        included_prorated_hours, req.params.id,
      ]
    );

    res.json(updated.rows[0]);
  } catch (err) {
    console.error('Error updating F-FVF:', err);
    res.status(500).json({ error: 'Failed to update F-FVF' });
  }
});

router.post('/:id/sign', requireAuth, async (req, res) => {
  try {
    const { role, signature } = req.body;
    if (!role || !signature) {
      return res.status(400).json({ error: 'role and signature are required' });
    }

    const { rows } = await pool.query('SELECT * FROM bcaba_final_verifications WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const existing = rows[0];

    const { trainee, supervisor } = await loadTraineeAndSupervisor(existing.trainee_id, existing.supervisor_id);
    const { userId } = req.auth;

    if (role === 'trainee') {
      if (trainee.user_id !== userId) return res.status(403).json({ error: 'Not authorized to sign as trainee' });
    } else if (role === 'supervisor') {
      if (supervisor.supervisor_user_id !== userId) return res.status(403).json({ error: 'Not authorized to sign as supervisor' });
    } else {
      return res.status(400).json({ error: "role must be 'trainee' or 'supervisor'" });
    }

    const signedAtField = role === 'trainee' ? 'trainee_signed_at' : 'supervisor_signed_at';

    const updated = await pool.query(
      `UPDATE bcaba_final_verifications SET ${signedAtField} = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    let finalRow = updated.rows[0];

    if (finalRow.trainee_signed_at && finalRow.supervisor_signed_at) {
      const finalize = await pool.query(
        `UPDATE bcaba_final_verifications SET status = 'finalized', updated_at = NOW() WHERE id = $1 RETURNING *`,
        [req.params.id]
      );
      finalRow = finalize.rows[0];
    } else {
      await pool.query(
        `UPDATE bcaba_final_verifications SET status = 'pending_supervisor', updated_at = NOW() WHERE id = $1`,
        [req.params.id]
      );
    }

    res.json(finalRow);
  } catch (err) {
    console.error('Error signing F-FVF:', err);
    res.status(500).json({ error: 'Failed to sign F-FVF' });
  }
});

router.post('/:id/decline', requireAuth, async (req, res) => {
  try {
    const { reason } = req.body;
    const { rows } = await pool.query('SELECT * FROM bcaba_final_verifications WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const existing = rows[0];

    const { supervisor } = await loadTraineeAndSupervisor(existing.trainee_id, existing.supervisor_id);
    if (supervisor.supervisor_user_id !== req.auth.userId) {
      return res.status(403).json({ error: 'Only the supervisor can decline' });
    }

    const updated = await pool.query(
      `UPDATE bcaba_final_verifications SET
        status = 'contested', supervisor_declined_at = NOW(), supervisor_decline_reason = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [reason || null, req.params.id]
    );

    res.json(updated.rows[0]);
  } catch (err) {
    console.error('Error declining F-FVF:', err);
    res.status(500).json({ error: 'Failed to decline F-FVF' });
  }
});

router.get('/:id/pdf', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bcaba_final_verifications WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const fv = rows[0];

    const { trainee, supervisor } = await loadTraineeAndSupervisor(fv.trainee_id, fv.supervisor_id);

    const { userId } = req.auth;
    if ((!trainee || trainee.user_id !== userId) && (!supervisor || supervisor.supervisor_user_id !== userId)) {
      return res.status(403).json({ error: 'Not authorized to view this F-FVF' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=ffvf-${fv.id}.pdf`);

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    doc.fontSize(18).text('Final Fieldwork Verification Form', { align: 'left' });
    doc.fontSize(11).fillColor('gray').text(fv.form_type === 'individual' ? 'Individual Supervisor' : 'Multiple Supervisors at One Organization');
    doc.moveDown();
    doc.fillColor('black').fontSize(10);

    doc.text(`Trainee Name: ${trainee.full_name}`);
    doc.text(`BACB ID #: ${trainee.bacb_account_id || ''}`);
    doc.text(`Supervisor Name: ${supervisor.supervisor_name}`);
    doc.text(`Supervisor BACB ID #: ${supervisor.bacb_account_id || ''}`);
    doc.text(`Fieldwork Type: ${fv.fieldwork_type}`);
    doc.text(`Organization: ${fv.organization_name || ''}`);
    doc.text(`Period: ${fv.period_start_date.toISOString().slice(0,10)} to ${fv.period_end_date.toISOString().slice(0,10)}`);
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
    doc.text(`Supervisor qualified for entire duration: ${fv.supervisor_qualified_entire_duration ? 'Yes' : 'No'}`);
    doc.text(`Supervisor completed 8-hour training: ${fv.supervisor_completed_8hr_training ? 'Yes' : 'No'}`);
    doc.text(`Supervisor designated in contract: ${fv.supervisor_designated_in_contract ? 'Yes' : 'No'}`);
    doc.moveDown();

    doc.fontSize(12).text('Signatures', { underline: true });
    doc.fontSize(10);
    doc.text(`Trainee signed: ${fv.trainee_signed_at ? fv.trainee_signed_at.toISOString().slice(0,10) : 'Not yet signed'}`);
    doc.text(`Supervisor signed: ${fv.supervisor_signed_at ? fv.supervisor_signed_at.toISOString().slice(0,10) : 'Not yet signed'}`);
    doc.moveDown();
    doc.fontSize(8).fillColor('gray').text('Both parties must retain a copy of this form for at least 7 years.');

    doc.end();
  } catch (err) {
    console.error('Error generating F-FVF PDF:', err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

export default router;