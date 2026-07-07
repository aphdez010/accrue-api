import express from 'express';
import Stripe from 'stripe';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

function pad(n) { return n < 10 ? '0' + n : String(n); }

async function getProfessionalId(clerkUserId) {
  const r = await pool.query('SELECT id FROM professionals WHERE clerk_user_id = $1', [clerkUserId]);
  if (r.rows.length === 0) return null;
  return r.rows[0].id;
}

async function getBcabaSupervisorId(clerkUserId) {
  const r = await pool.query('SELECT id FROM bcaba_supervisors WHERE supervisor_user_id = $1', [clerkUserId]);
  if (r.rows.length === 0) return null;
  return r.rows[0].id;
}

router.post('/draft-monthly', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const professionalId = await getProfessionalId(userId);
    if (!professionalId) return res.status(404).json({ error: 'Professional not found' });
    const bcabaSupervisorId = await getBcabaSupervisorId(userId);
    if (!bcabaSupervisorId) return res.status(404).json({ error: 'No BCaBA supervisor record found for this user' });

    const { monthYear } = req.body;
    if (!monthYear) return res.status(400).json({ error: 'monthYear is required (YYYY-MM-01)' });

    const periodStart = monthYear;
    const [y, m] = monthYear.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const periodEnd = `${y}-${pad(m)}-${pad(lastDay)}`;

    const hoursResult = await pool.query(
      `SELECT trainee_id, SUM(hours) as total_hours
       FROM bcaba_fieldwork_entries
       WHERE supervisor_id = $1 AND entry_date >= $2 AND entry_date <= $3
       GROUP BY trainee_id`,
      [bcabaSupervisorId, periodStart, periodEnd]
    );

    if (hoursResult.rows.length === 0) {
      return res.json({ created: [], message: 'No logged hours found for this period' });
    }

    const created = [];
    for (const row of hoursResult.rows) {
      const existing = await pool.query(
        `SELECT id FROM supervision_invoices WHERE trainee_id = $1 AND period_start = $2 AND period_end = $3`,
        [row.trainee_id, periodStart, periodEnd]
      );
      if (existing.rows.length > 0) continue;

      const insert = await pool.query(
        `INSERT INTO supervision_invoices
         (supervisor_id, trainee_id, trainee_type, period_start, period_end, hours_covered, status)
         VALUES ($1, $2, 'bcaba', $3, $4, $5, 'draft')
         RETURNING *`,
        [professionalId, row.trainee_id, periodStart, periodEnd, row.total_hours]
      );
      created.push(insert.rows[0]);
    }

    res.json({ created, skipped: hoursResult.rows.length - created.length });
  } catch (err) {
    console.error('POST /invoices/draft-monthly error:', err);
    res.status(500).json({ error: 'Failed to draft monthly invoices' });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const supervisorId = await getProfessionalId(userId);
    if (!supervisorId) return res.status(404).json({ error: 'Professional not found' });

    const { status, traineeId, monthYear } = req.query;
    const conditions = ['supervisor_id = $1'];
    const params = [supervisorId];
    let idx = 2;

    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (traineeId) { conditions.push(`trainee_id = $${idx++}`); params.push(traineeId); }
    if (monthYear) { conditions.push(`period_start = $${idx++}`); params.push(monthYear); }

    const result = await pool.query(
      `SELECT si.*, bt.full_name
       FROM supervision_invoices si
       LEFT JOIN bcaba_trainees bt ON bt.id = si.trainee_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY si.period_start DESC, si.created_at DESC`,
      params
    );

    res.json({ invoices: result.rows });
  } catch (err) {
    console.error('GET /invoices error:', err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const supervisorId = await getProfessionalId(userId);
    if (!supervisorId) return res.status(404).json({ error: 'Professional not found' });

    const { id } = req.params;
    const { amount, notes } = req.body;

    const existing = await pool.query(
      'SELECT * FROM supervision_invoices WHERE id = $1 AND supervisor_id = $2',
      [id, supervisorId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    if (existing.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Only draft invoices can be edited' });
    }

    const result = await pool.query(
      `UPDATE supervision_invoices SET amount = COALESCE($1, amount), notes = COALESCE($2, notes)
       WHERE id = $3 RETURNING *`,
      [amount, notes, id]
    );

    res.json({ invoice: result.rows[0] });
  } catch (err) {
    console.error('PATCH /invoices/:id error:', err);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

router.post('/:id/send', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const supervisorId = await getProfessionalId(userId);
    if (!supervisorId) return res.status(404).json({ error: 'Professional not found' });

    const { id } = req.params;
    const { paymentMethod, email } = req.body;
    if (!['stripe', 'manual'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'paymentMethod must be stripe or manual' });
    }

    const existing = await pool.query(
      `SELECT si.*, bt.full_name
       FROM supervision_invoices si
       LEFT JOIN bcaba_trainees bt ON bt.id = si.trainee_id
       WHERE si.id = $1 AND si.supervisor_id = $2`,
      [id, supervisorId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const invoice = existing.rows[0];

    if (!invoice.amount || Number(invoice.amount) <= 0) {
      return res.status(400).json({ error: 'Set an amount before sending' });
    }

    let checkoutUrl = null;

    if (paymentMethod === 'stripe') {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        ...(email ? { customer_email: email } : {}),
        line_items: [{
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(Number(invoice.amount) * 100),
            product_data: {
              name: `Supervision — ${invoice.full_name || ''}`.trim(),
              description: `${invoice.period_start} to ${invoice.period_end} (${invoice.hours_covered} hrs)`,
            },
          },
          quantity: 1,
        }],
        success_url: `${process.env.FRONTEND_URL || 'https://supervisd.com'}/dashboard/bcaba/invoices?paid=true`,
        cancel_url: `${process.env.FRONTEND_URL || 'https://supervisd.com'}/dashboard/bcaba/invoices`,
        metadata: { invoice_id: String(invoice.id) },
      });
      checkoutUrl = session.url;

      await pool.query(
        `UPDATE supervision_invoices SET status = 'sent', payment_method = $1, stripe_checkout_session_id = $2, sent_at = NOW(), trainee_email = COALESCE($3, trainee_email) WHERE id = $4`,
        ['stripe', session.id, email || null, id]
      );
    } else {
      await pool.query(
        `UPDATE supervision_invoices SET status = 'sent', payment_method = $1, sent_at = NOW(), trainee_email = COALESCE($2, trainee_email) WHERE id = $3`,
        ['manual', email || null, id]
      );
    }

    res.json({ success: true, checkoutUrl });
  } catch (err) {
    console.error('POST /invoices/:id/send error:', err);
    res.status(500).json({ error: 'Failed to send invoice' });
  }
});

router.patch('/:id/mark-paid', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const supervisorId = await getProfessionalId(userId);
    if (!supervisorId) return res.status(404).json({ error: 'Professional not found' });

    const { id } = req.params;
    const existing = await pool.query(
      'SELECT * FROM supervision_invoices WHERE id = $1 AND supervisor_id = $2',
      [id, supervisorId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });

    const result = await pool.query(
      `UPDATE supervision_invoices SET status = 'paid', paid_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    res.json({ invoice: result.rows[0] });
  } catch (err) {
    console.error('PATCH /invoices/:id/mark-paid error:', err);
    res.status(500).json({ error: 'Failed to mark invoice paid' });
  }
});

export default router;
