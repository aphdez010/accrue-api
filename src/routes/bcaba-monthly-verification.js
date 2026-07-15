import express from 'express';
import PDFDocument from 'pdfkit';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { checkMonthlyCompliance, adjustMonthlyHours } from './bcaba-rules.js';

const router = express.Router();

function pad(n) { return n < 10 ? '0' + n : String(n); }

// Resolves the bcaba_supervisors.id for a SPECIFIC (user, trainee) pair.
// bcaba_supervisors is a per-relationship table — one row per trainee a
// supervisor works with, not one row per supervisor. Previously this
// function ignored traineeId entirely and returned an arbitrary row, which
// meant a supervisor with more than one trainee could only ever act on
// whichever trainee's row happened to come back first, regardless of which
// trainee they were actually trying to view.
async function getBcabaSupervisorId(clerkUserId, traineeId) {
  const r = await pool.query(
    'SELECT id FROM bcaba_supervisors WHERE supervisor_user_id = $1 AND trainee_id = $2',
    [clerkUserId, traineeId]
  );
  if (r.rows.length === 0) return null;
  return r.rows[0].id;
}

// Resolves ALL bcaba_supervisors.id rows for this user across every trainee
// they supervise. Used by routes with no single traineeId in scope (e.g.
// listing verifications with no query filter).
async function getAllBcabaSupervisorIds(clerkUserId) {
  const r = await pool.query(
    'SELECT id FROM bcaba_supervisors WHERE supervisor_user_id = $1',
    [clerkUserId]
  );
  return r.rows.map(row => row.id);
}

// POST /bcaba-monthly-verification/draft
// Body: { traineeId, monthYear: 'YYYY-MM-01' }
// Auto-fills hour breakdowns from bcaba_fieldwork_entries; contacts_count defaults to 0 (supervisor confirms/edits).
router.post('/draft', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { traineeId, monthYear, fieldworkType: requestedFieldworkType } = req.body;
    if (!traineeId || !monthYear) return res.status(400).json({ error: 'traineeId and monthYear are required' });

    const supervisorId = await getBcabaSupervisorId(userId, traineeId);
    if (!supervisorId) return res.status(404).json({ error: 'No BCaBA supervisor record found for this user and trainee' });

    const traineeResult = await pool.query('SELECT fieldwork_type FROM bcaba_trainees WHERE id = $1', [traineeId]);
    if (traineeResult.rows.length === 0) return res.status(404).json({ error: 'Trainee not found' });
    // fieldworkType may be requested explicitly — a trainee who mixed Supervised
    // and Concentrated hours in one month needs a separate M-FVF per type, each
    // checked against that type's own rules (they can't be combined into one
    // form; see Handbook "Please complete one form per supervisor, per
    // fieldwork type"). Defaults to the trainee's primary track when omitted,
    // preserving prior behavior for trainees who never mix types.
    const fieldworkType = requestedFieldworkType || traineeResult.rows[0].fieldwork_type;

    const existing = await pool.query(
      'SELECT id FROM bcaba_monthly_verification WHERE trainee_id = $1 AND month_year = $2 AND fieldwork_type = $3',
      [traineeId, monthYear, fieldworkType]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: `A ${fieldworkType} monthly verification already exists for this trainee/month` });
    }

    const [y, m] = monthYear.split('-').map(Number);
    const periodStart = monthYear;
    const periodEnd = `${y}-${pad(m)}-${new Date(y, m, 0).getDate()}`;

    const entriesResult = await pool.query(
      `SELECT * FROM bcaba_fieldwork_entries
       WHERE trainee_id = $1 AND supervisor_id = $2 AND entry_date >= $3 AND entry_date <= $4
         AND COALESCE(fieldwork_type, 'supervised') = $5`,
      [traineeId, supervisorId, periodStart, periodEnd, fieldworkType]
    );
    const entries = entriesResult.rows;

    // Observation entries represent a supervisor directly observing the trainee
    // and are therefore supervised time, not independent time, per the BCaBA
    // Handbook's fieldwork documentation requirements — an observation is not
    // "supervisor not present." Independent hours are hours where no supervisor
    // was involved at all.
    const supervisedHours = entries
      .filter(e => e.entry_type === 'supervised' || e.entry_type === 'observation')
      .reduce((s, e) => s + Number(e.hours || 0), 0);
    const independentHours = entries
      .filter(e => e.entry_type !== 'supervised' && e.entry_type !== 'observation')
      .reduce((s, e) => s + Number(e.hours || 0), 0);
    const individualHours = entries.filter(e => e.supervision_format === 'individual').reduce((s, e) => s + Number(e.hours || 0), 0);
    const groupHours = entries.filter(e => e.supervision_format === 'group').reduce((s, e) => s + Number(e.hours || 0), 0);
    const observationCompleted = entries.some(e => e.entry_type === 'observation');
    const totalHours = supervisedHours + independentHours;

    // Supervisor-trainee contacts: real-time interactions only, per Handbook p.20
    // ("if your supervisor watches a recorded video... but does not provide
    // immediate, real-time feedback, that hour... [does not] count toward the
    // supervisor-trainee contact requirement"). Matches the equivalent rule
    // already applied on the BCBA side (bcba-rules.js / compliance.js). This
    // was previously hardcoded to a literal 0 below, which meant every draft
    // always failed the contacts requirement regardless of actual entries.
    const contactsCount = entries.filter(
      (e) => (e.entry_type === 'supervised' || e.entry_type === 'observation') && e.entry_sync_type === 'synchronized'
    ).length;

    const insert = await pool.query(
      `INSERT INTO bcaba_monthly_verification
       (trainee_id, supervisor_id, month_year, independent_hours, supervised_hours, contacts_count,
        observation_completed, individual_supervision_hours, group_supervision_hours, adjusted_hours, status, fieldwork_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11)
       RETURNING *`,
      [traineeId, supervisorId, monthYear, independentHours, supervisedHours, contactsCount, observationCompleted, individualHours, groupHours, totalHours, fieldworkType]
    );
    const record = insert.rows[0];

    const compliance = checkMonthlyCompliance({
      fieldworkType,
      totalHours,
      contactsCount,
      observationCompleted,
      individualHours,
      groupHours,
      supervisedHours,
    });

    res.json({ verification: record, compliance });
  } catch (err) {
    console.error('POST /bcaba-monthly-verification/draft error:', err);
    res.status(500).json({ error: 'Failed to draft monthly verification' });
  }
});

// GET /bcaba-monthly-verification?traineeId=1
// With traineeId: scoped to that specific supervisor-trainee relationship.
// Without traineeId: returns verifications across every trainee this
// supervisor works with.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { traineeId } = req.query;

    let result;
    if (traineeId) {
      const supervisorId = await getBcabaSupervisorId(userId, traineeId);
      if (!supervisorId) return res.status(404).json({ error: 'No BCaBA supervisor record found for this user and trainee' });
      result = await pool.query(
        'SELECT * FROM bcaba_monthly_verification WHERE supervisor_id = $1 AND trainee_id = $2 ORDER BY month_year DESC',
        [supervisorId, traineeId]
      );
    } else {
      const supervisorIds = await getAllBcabaSupervisorIds(userId);
      if (supervisorIds.length === 0) return res.status(404).json({ error: 'No BCaBA supervisor record found for this user' });
      result = await pool.query(
        'SELECT * FROM bcaba_monthly_verification WHERE supervisor_id = ANY($1) ORDER BY month_year DESC',
        [supervisorIds]
      );
    }

    res.json({ verifications: result.rows });
  } catch (err) {
    console.error('GET /bcaba-monthly-verification error:', err);
    res.status(500).json({ error: 'Failed to fetch monthly verifications' });
  }
});

// PATCH /bcaba-monthly-verification/:id
// Body: { contactsCount, observationCompleted } — supervisor confirms/edits before signing
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { id } = req.params;
    const { contactsCount, observationCompleted } = req.body;

    const existing = await pool.query('SELECT * FROM bcaba_monthly_verification WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Verification not found' });
    const record = existing.rows[0];

    const supervisorId = await getBcabaSupervisorId(userId, record.trainee_id);
    if (!supervisorId || supervisorId !== record.supervisor_id) {
      return res.status(404).json({ error: 'No BCaBA supervisor record found for this user and trainee' });
    }
    if (record.status !== 'draft') return res.status(400).json({ error: 'Only draft verifications can be edited' });

    const result = await pool.query(
      `UPDATE bcaba_monthly_verification
       SET contacts_count = COALESCE($1, contacts_count), observation_completed = COALESCE($2, observation_completed)
       WHERE id = $3 RETURNING *`,
      [contactsCount, observationCompleted, id]
    );
    res.json({ verification: result.rows[0] });
  } catch (err) {
    console.error('PATCH /bcaba-monthly-verification/:id error:', err);
    res.status(500).json({ error: 'Failed to update verification' });
  }
});

// PATCH /bcaba-monthly-verification/:id/sign
// Body: { role: 'trainee' | 'supervisor', signature: base64 data URL }
router.patch('/:id/sign', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { id } = req.params;
    const { role, signature } = req.body;
    if (!['trainee', 'supervisor'].includes(role)) return res.status(400).json({ error: 'role must be trainee or supervisor' });
    if (!signature) return res.status(400).json({ error: 'signature is required' });

    const existing = await pool.query('SELECT * FROM bcaba_monthly_verification WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Verification not found' });
    const record = existing.rows[0];

    // Verify the signer's identity actually matches the role they're claiming
    if (role === 'trainee') {
      const traineeCheck = await pool.query('SELECT id FROM bcaba_trainees WHERE id = $1 AND user_id = $2', [record.trainee_id, userId]);
      if (traineeCheck.rows.length === 0) return res.status(403).json({ error: 'You are not the trainee on this record' });
    } else {
      const supCheck = await pool.query('SELECT id FROM bcaba_supervisors WHERE id = $1 AND supervisor_user_id = $2', [record.supervisor_id, userId]);
      if (supCheck.rows.length === 0) return res.status(403).json({ error: 'You are not the supervisor on this record' });
    }

    const timestampField = role === 'trainee' ? 'trainee_signed_at' : 'supervisor_signed_at';
    const signatureField = role === 'trainee' ? 'trainee_signature' : 'supervisor_signature';

    const result = await pool.query(
      `UPDATE bcaba_monthly_verification SET ${timestampField} = NOW(), ${signatureField} = $2 WHERE id = $1 RETURNING *`,
      [id, signature]
    );
    let updated = result.rows[0];

    if (updated.trainee_signed_at && updated.supervisor_signed_at) {
      const finalized = await pool.query(
        `UPDATE bcaba_monthly_verification SET status = 'finalized' WHERE id = $1 RETURNING *`,
        [id]
      );
      updated = finalized.rows[0];
    }

    res.json({ verification: updated });
  } catch (err) {
    console.error('PATCH /bcaba-monthly-verification/:id/sign error:', err);
    res.status(500).json({ error: 'Failed to sign verification' });
  }
});

// GET /bcaba-monthly-verification/mine — trainee-side: records for the logged-in trainee
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const traineeResult = await pool.query('SELECT id FROM bcaba_trainees WHERE user_id = $1', [userId]);
    if (traineeResult.rows.length === 0) return res.status(404).json({ error: 'No trainee record found for this user' });
    const traineeId = traineeResult.rows[0].id;

    const result = await pool.query(
      'SELECT * FROM bcaba_monthly_verification WHERE trainee_id = $1 ORDER BY month_year DESC',
      [traineeId]
    );
    res.json({ verifications: result.rows });
  } catch (err) {
    console.error('GET /bcaba-monthly-verification/mine error:', err);
    res.status(500).json({ error: 'Failed to fetch verifications' });
  }
});

// GET /bcaba-monthly-verification/:id/pdf — generates a PDF matching BACB's M-FVF layout
router.get('/:id/pdf', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { id } = req.params;

    const result = await pool.query('SELECT * FROM bcaba_monthly_verification WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Verification not found' });
    const v = result.rows[0];

    // Access check: allow either the trainee or the supervisor on this record
    const traineeCheck = await pool.query('SELECT id, user_id, full_name, bacb_account_id, fieldwork_type FROM bcaba_trainees WHERE id = $1', [v.trainee_id]);
    const supCheck = await pool.query('SELECT id, supervisor_name, bacb_account_id, supervisor_user_id FROM bcaba_supervisors WHERE id = $1', [v.supervisor_id]);
    if (traineeCheck.rows.length === 0 || supCheck.rows.length === 0) return res.status(404).json({ error: 'Related trainee/supervisor record not found' });
    const trainee = traineeCheck.rows[0];
    const supervisor = supCheck.rows[0];

    const isTrainee = trainee.user_id === userId;
    const isSupervisor = supervisor.supervisor_user_id === userId;
    if (!isTrainee && !isSupervisor) return res.status(403).json({ error: 'Not authorized to view this record' });

    const totalHours = Number(v.independent_hours) + Number(v.supervised_hours);
    const supervisionPct = totalHours > 0 ? (Number(v.supervised_hours) / totalHours) * 100 : 0;
    const monthLabel = new Date(v.month_year).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    // Use this record's own fieldwork_type, not the trainee's primary track —
    // a trainee who mixes tracks can have M-FVFs of both types, and this PDF
    // must reflect which one THIS record actually is.
    const fieldworkTypeLabel = (v.fieldwork_type || trainee.fieldwork_type) === 'concentrated' ? 'Concentrated Supervised Fieldwork' : 'Supervised Fieldwork';

    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="mfvf-${monthLabel.replace(' ', '-')}.pdf"`);
    doc.pipe(res);

    const MARGIN = 50;
    const PAGE_W = doc.page.width;
    const CONTENT_W = PAGE_W - MARGIN * 2;

    doc.rect(MARGIN, MARGIN, CONTENT_W, 4).fill('#1A7A50');
    doc.y = MARGIN + 16;
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#0F2018').text('Monthly Fieldwork Verification Form', MARGIN);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#5A7A65').text('Individual Supervisor', MARGIN);
    doc.font('Helvetica').fontSize(8).fillColor('#9AB5A5').text('Generated by Supervisd  ·  Both parties must retain a copy for at least 7 years  ·  Do not submit to the BACB unless requested', MARGIN, doc.y + 4);
    doc.moveDown(1.2);

    function field(label, value, x, y, w) {
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#5A7A65').text(label.toUpperCase(), x, y, { width: w });
      doc.font('Helvetica').fontSize(11).fillColor('#0F2018').text(value || '—', x, y + 12, { width: w });
    }

    let y = doc.y;
    field('Trainee Name', trainee.full_name, MARGIN, y, 260);
    field('BACB ID #', trainee.bacb_account_id, MARGIN + 280, y, 120);
    field('Month/Year', monthLabel, MARGIN + 410, y, 140);

    y += 42;
    field('Fieldwork Type', fieldworkTypeLabel, MARGIN, y, 260);
    field('State Where Fieldwork Occurred', '', MARGIN + 280, y, 120);
    field('Country', '', MARGIN + 410, y, 140);

    y += 42;
    field('Supervisor Name', supervisor.supervisor_name, MARGIN, y, 260);
    field('Certification # / BACB ID #', supervisor.bacb_account_id, MARGIN + 280, y, 260);

    y += 42;
    doc.rect(MARGIN, y, CONTENT_W, 1).fill('#D8E4DC');
    y += 14;

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#0F2018').text('Fieldwork Hours (this month only)', MARGIN, y);
    y += 18;
    field('A. Independent Hours (supervisor not present)', Number(v.independent_hours).toFixed(1), MARGIN, y, 260);
    field('B. Supervised Hours (supervisor present)', Number(v.supervised_hours).toFixed(1), MARGIN + 280, y, 260);

    y += 42;
    field('Total Fieldwork Hours (A + B)', totalHours.toFixed(1), MARGIN, y, 200);
    field('Percent of Hours Supervised', supervisionPct.toFixed(1) + '%', MARGIN + 220, y, 200);
    field('Supervisory Contacts', String(v.contacts_count), MARGIN + 420, y, 130);

    y += 42;
    doc.rect(MARGIN, y, CONTENT_W, 1).fill('#D8E4DC');
    y += 16;

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#0F2018').text('Supervisor and Trainee Attestation', MARGIN, y);
    y += 16;
    doc.font('Helvetica').fontSize(8).fillColor('#5A7A65').text('By signing below, we hereby attest that:', MARGIN, y);
    y += 12;

    const attestations = [
      'The information contained on this form is true and correct to the best of our knowledge;',
      'The required number of supervisory contacts occurred during this month;',
      'Observation of the trainee with a client occurred during this supervisory period with a frequency appropriate for this fieldwork type;',
      'The trainee was supervised for the required amount of time for this supervisory period;',
      'We have read and understand the most recent version of the Fieldwork Requirements (BCBA/BCaBA);',
      'We are only including appropriate behavior-analytic activities in our totals listed above; and',
      'The fieldwork hours obtained during this supervisory period are otherwise compliant with the Fieldwork Requirements (BCBA/BCaBA).',
    ];
    attestations.forEach(line => {
      doc.font('Helvetica').fontSize(8).fillColor('#0F2018').text('•  ' + line, MARGIN, doc.y, { width: CONTENT_W });
      doc.moveDown(0.2);
    });

    doc.moveDown(1);
    const sigY = doc.y;

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#5A7A65').text('SUPERVISOR SIGNATURE', MARGIN, sigY);
    if (v.supervisor_signature) {
      const buf = Buffer.from(v.supervisor_signature.split(',')[1], 'base64');
      doc.image(buf, MARGIN, sigY + 16, { width: 160, height: 40 });
    }
    doc.rect(MARGIN, sigY + 60, 260, 1).fill('#0F2018');
    doc.font('Helvetica').fontSize(8).fillColor('#9AB5A5').text(
      'Date: ' + (v.supervisor_signed_at ? new Date(v.supervisor_signed_at).toLocaleDateString() : '____________'),
      MARGIN, sigY + 66
    );

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#5A7A65').text('TRAINEE SIGNATURE', MARGIN + 300, sigY);
    if (v.trainee_signature) {
      const buf2 = Buffer.from(v.trainee_signature.split(',')[1], 'base64');
      doc.image(buf2, MARGIN + 300, sigY + 16, { width: 160, height: 40 });
    }
    doc.rect(MARGIN + 300, sigY + 60, 260, 1).fill('#0F2018');
    doc.font('Helvetica').fontSize(8).fillColor('#9AB5A5').text(
      'Date: ' + (v.trainee_signed_at ? new Date(v.trainee_signed_at).toLocaleDateString() : '____________'),
      MARGIN + 300, sigY + 66
    );

    doc.font('Helvetica').fontSize(7).fillColor('#9AB5A5')
      .text('This document must be signed in accordance with the Acceptable Signatures Policy.', MARGIN, doc.page.height - 40, { width: CONTENT_W, align: 'center' });

    doc.end();
  } catch (err) {
    console.error('GET /bcaba-monthly-verification/:id/pdf error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

export default router;