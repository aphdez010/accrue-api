import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const CEU_REQUIREMENTS = { total: 32, ethics: 4, supervision: 3 };

// Determines the current 2-year recertification cycle window from whatever
// dates are on file. recertification_date is treated as the next known cycle
// boundary; once it's passed, the cycle rolls forward by 2 years repeatedly
// (matching how BACB cycles renew every 2 years) so this always reflects the
// currently active cycle, not a stale one-time date.
function computeCycle(certificationDate, recertificationDate, now = new Date()) {
  const anchor = recertificationDate || certificationDate;
  if (!anchor) return null;
  const cycleEnd = new Date(anchor);
  while (cycleEnd < now) {
    cycleEnd.setFullYear(cycleEnd.getFullYear() + 2);
  }
  const cycleStart = new Date(cycleEnd);
  cycleStart.setFullYear(cycleStart.getFullYear() - 2);
  return { cycleStart, cycleEnd };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1', [userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });
    const { rows } = await pool.query(
      'SELECT * FROM ceus WHERE professional_id = $1 ORDER BY completion_date DESC',
      [pro.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /ceus/summary — progress against the Handbook's Certification
// Maintenance Requirements: 32 CEUs per 2-year cycle, including at least 4
// ethics and (if you supervised anyone during the cycle) at least 3
// supervision CEUs.
//
// Note on the supervision-CEU trigger: the Handbook requires the 3 supervision
// CEUs only for certificants who supervised the ongoing practice of an RBT or
// BCaBA, or a BCBA/BCaBA trainee's fieldwork, at any point during the cycle.
// This checks both BCaBA-linked supervision (bcaba_supervisors.supervisor_user_id)
// and BCBA-linked supervision (supervisors.supervisor_user_id, added once a
// trainee links their supervisor's account via PATCH /supervisors/:id/link).
// Both are real account links, but a supervisor only shows up here once a
// trainee has actually linked them — an unlinked (free-text-only) supervisor
// relationship still can't be detected. supervisionRequired is therefore a
// best-effort signal, not a guarantee — always show the requirement as
// relevant rather than hiding it when uncertain.
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { rows: [pro] } = await pool.query(
      'SELECT id, certification_date, recertification_date FROM professionals WHERE clerk_user_id = $1', [userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });

    const cycle = computeCycle(pro.certification_date, pro.recertification_date);
    if (!cycle) {
      return res.json({
        cycleSet: false,
        message: 'Set your certification date to see CEU compliance tracking against your actual recertification cycle.',
      });
    }

    const cycleStartStr = cycle.cycleStart.toISOString().slice(0, 10);
    const cycleEndStr = cycle.cycleEnd.toISOString().slice(0, 10);

    const { rows: ceuRows } = await pool.query(
      `SELECT * FROM ceus WHERE professional_id = $1 AND completion_date >= $2 AND completion_date <= $3`,
      [pro.id, cycleStartStr, cycleEndStr]
    );

    const totalHours = ceuRows.reduce((s, c) => s + Number(c.hours || 0), 0);
    const ethicsHours = ceuRows.filter(c => c.category === 'ethics').reduce((s, c) => s + Number(c.hours || 0), 0);
    const supervisionHours = ceuRows.filter(c => c.category === 'supervision').reduce((s, c) => s + Number(c.hours || 0), 0);

    const { rows: [bcabaSupCount] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM bcaba_supervisors WHERE supervisor_user_id = $1`,
      [userId]
    );
    const { rows: [bcbaSupCount] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM supervisors WHERE supervisor_user_id = $1`,
      [userId]
    );
    const supervisionRequired = Number(bcabaSupCount.count) > 0 || Number(bcbaSupCount.count) > 0;

    const now = new Date();
    const daysUntilRecertification = Math.ceil((cycle.cycleEnd - now) / (1000 * 60 * 60 * 24));

    res.json({
      cycleSet: true,
      cycleStart: cycleStartStr,
      cycleEnd: cycleEndStr,
      daysUntilRecertification,
      requirements: CEU_REQUIREMENTS,
      progress: {
        total: totalHours,
        ethics: ethicsHours,
        supervision: supervisionHours,
      },
      met: {
        total: totalHours >= CEU_REQUIREMENTS.total,
        ethics: ethicsHours >= CEU_REQUIREMENTS.ethics,
        supervision: !supervisionRequired || supervisionHours >= CEU_REQUIREMENTS.supervision,
      },
      supervisionRequired,
      compliant: totalHours >= CEU_REQUIREMENTS.total
        && ethicsHours >= CEU_REQUIREMENTS.ethics
        && (!supervisionRequired || supervisionHours >= CEU_REQUIREMENTS.supervision),
    });
  } catch (err) {
    console.error('GET /ceus/summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /ceus/certification — sets/updates the professional's own BCBA/BCaBA
// certification date and (optionally) their next known recertification date,
// which anchors the 2-year cycle used by GET /ceus/summary.
// Body: { certificationDate, recertificationDate }
router.patch('/certification', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { certificationDate, recertificationDate } = req.body;
    const { rows: [updated] } = await pool.query(
      `UPDATE professionals
       SET certification_date = COALESCE($1, certification_date),
           recertification_date = COALESCE($2, recertification_date)
       WHERE clerk_user_id = $3
       RETURNING id, certification_date, recertification_date`,
      [certificationDate || null, recertificationDate || null, userId]
    );
    if (!updated) return res.status(404).json({ error: 'Professional not found' });
    res.json(updated);
  } catch (err) {
    console.error('PATCH /ceus/certification error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1', [userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });
    const { course_title, provider, hours, completion_date, category, certificate_url } = req.body;
    const { rows: [ceu] } = await pool.query(
      `INSERT INTO ceus (professional_id, course_title, provider, hours, completion_date, category, certificate_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [pro.id, course_title, provider || null, hours, completion_date, category || 'general', certificate_url || null]
    );
    res.json(ceu);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { rows: [pro] } = await pool.query(
      'SELECT id FROM professionals WHERE clerk_user_id = $1', [userId]
    );
    if (!pro) return res.status(404).json({ error: 'Professional not found' });
    await pool.query(
      'DELETE FROM ceus WHERE id = $1 AND professional_id = $2',
      [req.params.id, pro.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
