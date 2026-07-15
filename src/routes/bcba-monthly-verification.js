import express from 'express';
import PDFDocument from 'pdfkit';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { getBcbaRules } from './bcba-rules.js';

const router = express.Router();

function pad(n) { return n < 10 ? '0' + n : String(n); }

async function getProfessional(clerkUserId) {
  const { rows } = await pool.query('SELECT * FROM professionals WHERE clerk_user_id = $1', [clerkUserId]);
  return rows[0] || null;
}

// Mirrors bcaba-rules.js's checkMonthlyCompliance() shape/behavior, but reads
// BCBA's rule set (which varies by fieldworkStartDate: 2022 vs 2027 Handbook
// rules) via getBcbaRules() instead of BCaBA's fixed BCABA_REQUIREMENTS.
function checkMonthlyCompliance({ rules, totalHours, contactsCount, observationCompleted, observationMinutes, individualHours, groupHours, supervisedHours }) {
  const issues = [];
  const obsReq = rules.observationRequirement;
  const observationMet = obsReq.type === 'minutes' ? (observationMinutes || 0) >= obsReq.value : !!observationCompleted;
  if (!observationMet) issues.push('no_observation');
  if (totalHours < rules.hoursPerPeriod.min) issues.push('under_min_hours');
  if (totalHours > rules.hoursPerPeriod.max) issues.push('over_max_hours');
  // contactsPerMonth is null under 2027 BCBA rules (no discrete-contacts
  // requirement, replaced by cumulative observation minutes) -- see bcba-rules.js.
  if (rules.contactsPerMonth != null && contactsCount < rules.contactsPerMonth) issues.push('insufficient_contacts');
  if (groupHours > individualHours) issues.push('group_exceeds_individual');
  const supervisionPct = totalHours > 0 ? supervisedHours / totalHours : 0;
  if (supervisionPct < rules.supervisionPct) issues.push('supervision_pct_below_min');
  return { compliant: issues.length === 0, issues };
}

// POST /bcba-monthly-verification/draft
// Body: { supervisorId, monthYear: 'YYYY-MM-01', fieldworkType? }
// Trainee-initiated (BCBA supervisors aren't linked accounts, unlike BCaBA's
// bcaba_supervisors.supervisor_user_id -- so unlike the BCaBA flow, the
// trainee drafts their own M-FVF here rather than their supervisor).
router.post('/draft', requireAuth, async (req, res) => {
  try {
    const pro = await getProfessional(req.auth.userId);
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { supervisorId, monthYear, fieldworkType: requestedFieldworkType } = req.body;
    if (!supervisorId || !monthYear) return res.status(400).json({ error: 'supervisorId and monthYear are required' });

    const { rows: [supervisor] } = await pool.query(
      'SELECT * FROM supervisors WHERE id = $1 AND professional_id = $2',
      [supervisorId, pro.id]
    );
    if (!supervisor) return res.status(404).json({ error: 'Supervisor not found' });

    const fieldworkType = requestedFieldworkType || pro.bcba_supervision_track || 'supervised';

    const existing = await pool.query(
      'SELECT id FROM bcba_monthly_verification WHERE professional_id = $1 AND month_year = $2 AND fieldwork_type = $3',
      [pro.id, monthYear, fieldworkType]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: `A ${fieldworkType} monthly verification already exists for this month` });
    }

    const [y, m] = monthYear.split('-').map(Number);
    const periodStart = monthYear;
    const periodEnd = `${y}-${pad(m)}-${new Date(y, m, 0).getDate()}`;

    const entriesResult = await pool.query(
      `SELECT * FROM fieldwork_entries
       WHERE professional_id = $1 AND supervisor_id = $2 AND entry_date >= $3 AND entry_date <= $4
         AND COALESCE(fieldwork_type, 'supervised') = $5`,
      [pro.id, supervisorId, periodStart, periodEnd, fieldworkType]
    );
    const entries = entriesResult.rows;

    const supervisedHours = entries.filter(e => e.supervised).reduce((s, e) => s + Number(e.hours || 0), 0);
    const independentHours = entries.filter(e => !e.supervised).reduce((s, e) => s + Number(e.hours || 0), 0);
    const individualHours = entries.filter(e => e.supervised && e.supervision_group_type === 'Individual').reduce((s, e) => s + Number(e.hours || 0), 0);
    const groupHours = entries.filter(e => e.supervised && e.supervision_group_type === 'Group').reduce((s, e) => s + Number(e.hours || 0), 0);
    const totalHours = supervisedHours + independentHours;

    // Contacts: real-time interactions only (Handbook p.20) -- matches the
    // same rule already applied in compliance.js.
    const contactsCount = entries.filter(e => e.supervised && e.entry_sync_type === 'Synchronized').length;
    const observationCompleted = entries.some(e => e.monthly_observation);
    const observationMinutes = entries
      .filter(e => e.monthly_observation)
      .reduce((s, e) => s + Number(e.observation_minutes || 0), 0);

    // fieldwork_start_date determines whether 2022 or 2027 Handbook rules
    // apply for this trainee -- fall back to the earliest logged entry if not
    // set explicitly on the professional record.
    const startDate = pro.fieldwork_start_date
      || (entries.length > 0 ? entries.map(e => e.entry_date).sort()[0] : new Date());
    const rules = getBcbaRules(fieldworkType, startDate);

    const insert = await pool.query(
      `INSERT INTO bcba_monthly_verification
       (professional_id, supervisor_id, month_year, fieldwork_type, independent_hours, supervised_hours,
        contacts_count, observation_completed, observation_minutes, individual_supervision_hours,
        group_supervision_hours, adjusted_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'draft')
       RETURNING *`,
      [pro.id, supervisorId, monthYear, fieldworkType, independentHours, supervisedHours,
        contactsCount, observationCompleted, observationMinutes, individualHours, groupHours, totalHours]
    );
    const record = insert.rows[0];

    const compliance = checkMonthlyCompliance({
      rules, totalHours, contactsCount, observationCompleted, observationMinutes,
      individualHours, groupHours, supervisedHours,
    });

    res.json({ verification: record, compliance });
  } catch (err) {
    console.error('POST /bcba-monthly-verification/draft error:', err);
    res.status(500).json({ error: 'Failed to draft monthly verification' });
  }
});

// GET /bcba-monthly-verification/mine
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const pro = await getProfessional(req.auth.userId);
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { rows } = await pool.query(
      `SELECT mv.*, s.supervisor_name FROM bcba_monthly_verification mv
       JOIN supervisors s ON s.id = mv.supervisor_id
       WHERE mv.professional_id = $1 ORDER BY mv.month_year DESC`,
      [pro.id]
    );
    res.json({ verifications: rows });
  } catch (err) {
    console.error('GET /bcba-monthly-verification/mine error:', err);
    res.status(500).json({ error: 'Failed to fetch verifications' });
  }
});

// PATCH /bcba-monthly-verification/:id/sign
// Body: { role: 'trainee' | 'supervisor', signature }
// Both signatures are captured within the trainee's own session -- there is
// no separate supervisor login on the BCBA side (see file header note).
router.patch('/:id/sign', requireAuth, async (req, res) => {
  try {
    const pro = await getProfessional(req.auth.userId);
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { id } = req.params;
    const { role, signature } = req.body;
    if (!['trainee', 'supervisor'].includes(role)) return res.status(400).json({ error: 'role must be trainee or supervisor' });
    if (!signature) return res.status(400).json({ error: 'signature is required' });

    const { rows: [record] } = await pool.query('SELECT * FROM bcba_monthly_verification WHERE id = $1', [id]);
    if (!record) return res.status(404).json({ error: 'Verification not found' });
    if (record.professional_id !== pro.id) return res.status(403).json({ error: 'Not authorized for this record' });

    const timestampField = role === 'trainee' ? 'trainee_signed_at' : 'supervisor_signed_at';
    const signatureField = role === 'trainee' ? 'trainee_signature' : 'supervisor_signature';

    const result = await pool.query(
      `UPDATE bcba_monthly_verification SET ${timestampField} = NOW(), ${signatureField} = $2 WHERE id = $1 RETURNING *`,
      [id, signature]
    );
    let updated = result.rows[0];

    if (updated.trainee_signed_at && updated.supervisor_signed_at) {
      const finalized = await pool.query(
        `UPDATE bcba_monthly_verification SET status = 'finalized' WHERE id = $1 RETURNING *`,
        [id]
      );
      updated = finalized.rows[0];
    }

    res.json({ verification: updated });
  } catch (err) {
    console.error('PATCH /bcba-monthly-verification/:id/sign error:', err);
    res.status(500).json({ error: 'Failed to sign verification' });
  }
});

// DELETE /bcba-monthly-verification/:id — only undrafted (unsigned) records
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const pro = await getProfessional(req.auth.userId);
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { rows: [record] } = await pool.query('SELECT * FROM bcba_monthly_verification WHERE id = $1', [req.params.id]);
    if (!record) return res.status(404).json({ error: 'Verification not found' });
    if (record.professional_id !== pro.id) return res.status(403).json({ error: 'Not authorized for this record' });
    if (record.status !== 'draft') return res.status(400).json({ error: 'Only draft verifications can be deleted' });

    await pool.query('DELETE FROM bcba_monthly_verification WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /bcba-monthly-verification/:id error:', err);
    res.status(500).json({ error: 'Failed to delete verification' });
  }
});

// GET /bcba-monthly-verification/:id/pdf
router.get('/:id/pdf', requireAuth, async (req, res) => {
  try {
    const pro = await getProfessional(req.auth.userId);
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const { rows: [v] } = await pool.query('SELECT * FROM bcba_monthly_verification WHERE id = $1', [req.params.id]);
    if (!v) return res.status(404).json({ error: 'Verification not found' });
    if (v.professional_id !== pro.id) return res.status(403).json({ error: 'Not authorized to view this record' });

    const { rows: [supervisor] } = await pool.query('SELECT * FROM supervisors WHERE id = $1', [v.supervisor_id]);

    const totalHours = Number(v.independent_hours) + Number(v.supervised_hours);
    const supervisionPct = totalHours > 0 ? (Number(v.supervised_hours) / totalHours) * 100 : 0;
    const monthLabel = new Date(v.month_year).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const fieldworkTypeLabel = v.fieldwork_type === 'concentrated' ? 'Concentrated Supervised Fieldwork' : 'Supervised Fieldwork';

    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bcba-mfvf-${monthLabel.replace(' ', '-')}.pdf"`);
    doc.pipe(res);

    const MARGIN = 50;
    const PAGE_W = doc.page.width;
    const CONTENT_W = PAGE_W - MARGIN * 2;

    doc.rect(MARGIN, MARGIN, CONTENT_W, 4).fill('#1A7A50');
    doc.y = MARGIN + 16;
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#0F2018').text('Monthly Fieldwork Verification Form', MARGIN);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#5A7A65').text('Individual Supervisor — BCBA', MARGIN);
    doc.font('Helvetica').fontSize(8).fillColor('#9AB5A5').text('Generated by Supervisd  ·  Both parties must retain a copy for at least 7 years  ·  Do not submit to the BACB unless requested', MARGIN, doc.y + 4);
    doc.moveDown(1.2);

    function field(label, value, x, y, w) {
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#5A7A65').text(label.toUpperCase(), x, y, { width: w });
      doc.font('Helvetica').fontSize(11).fillColor('#0F2018').text(value || '—', x, y + 12, { width: w });
    }

    let y = doc.y;
    field('Trainee Name', pro.full_name, MARGIN, y, 260);
    field('BACB ID #', pro.credential_number, MARGIN + 280, y, 120);
    field('Month/Year', monthLabel, MARGIN + 410, y, 140);

    y += 42;
    field('Fieldwork Type', fieldworkTypeLabel, MARGIN, y, 260);
    field('State Where Fieldwork Occurred', '', MARGIN + 280, y, 120);
    field('Country', '', MARGIN + 410, y, 140);

    y += 42;
    field('Supervisor Name', supervisor?.supervisor_name, MARGIN, y, 260);
    field('Certification # / BACB ID #', supervisor?.supervisor_credential, MARGIN + 280, y, 260);

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
      'The required number of supervisory contacts occurred during this month (or, under 2027 rules, the required cumulative observation minutes were met);',
      'Observation of the trainee with a client occurred during this supervisory period with a frequency appropriate for this fieldwork type;',
      'The trainee was supervised for the required amount of time for this supervisory period;',
      'We have read and understand the most recent version of the Fieldwork Requirements (BCBA);',
      'We are only including appropriate behavior-analytic activities in our totals listed above; and',
      'The fieldwork hours obtained during this supervisory period are otherwise compliant with the Fieldwork Requirements (BCBA).',
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
    console.error('GET /bcba-monthly-verification/:id/pdf error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

export default router;
