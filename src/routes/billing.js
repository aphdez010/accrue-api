import express from 'express'
import Stripe from 'stripe'
import { pool } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const router = express.Router()

// POST /billing/checkout — create Stripe checkout session
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth

    const proResult = await pool.query('SELECT * FROM professionals WHERE clerk_user_id = $1', [userId])
    if (proResult.rows.length === 0) return res.status(404).json({ error: 'Professional not found' })
    const pro = proResult.rows[0]

    // Create or retrieve Stripe customer
    let customerId = pro.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: pro.email,
        name: pro.full_name,
        metadata: { professional_id: pro.id, clerk_user_id: userId },
      })
      customerId = customer.id
      await pool.query('UPDATE professionals SET stripe_customer_id = $1 WHERE id = $2', [customerId, pro.id])
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL || 'https://supervisd.com'}/dashboard?subscribed=true`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://supervisd.com'}/dashboard/billing`,
      metadata: { professional_id: pro.id },
    })

    res.json({ url: session.url })
  } catch (err) {
    console.error('POST /billing/checkout error:', err)
    res.status(500).json({ error: 'Failed to create checkout session' })
  }
})

// POST /billing/portal — customer portal for managing subscription
router.post('/portal', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth
    const proResult = await pool.query('SELECT * FROM professionals WHERE clerk_user_id = $1', [userId])
    if (proResult.rows.length === 0) return res.status(404).json({ error: 'Professional not found' })
    const pro = proResult.rows[0]

    if (!pro.stripe_customer_id) return res.status(400).json({ error: 'No active subscription' })

    const session = await stripe.billingPortal.sessions.create({
      customer: pro.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL || 'https://supervisd.com'}/dashboard/billing`,
    })

    res.json({ url: session.url })
  } catch (err) {
    console.error('POST /billing/portal error:', err)
    res.status(500).json({ error: 'Failed to create portal session' })
  }
})

// GET /billing/status — get subscription status
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth
    const proResult = await pool.query(
      'SELECT subscription_status, stripe_customer_id FROM professionals WHERE clerk_user_id = $1',
      [userId]
    )
    if (proResult.rows.length === 0) return res.status(404).json({ error: 'Professional not found' })
    res.json(proResult.rows[0])
  } catch (err) {
    console.error('GET /billing/status error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /billing/webhook — Stripe webhook handler
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('Webhook signature error:', err.message)
    return res.status(400).json({ error: 'Invalid signature' })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const professionalId = session.metadata?.professional_id
        if (professionalId) {
          await pool.query(
            'UPDATE professionals SET subscription_status = $1 WHERE id = $2',
            ['active', professionalId]
          )
        }
        break
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object
        const customer = await stripe.customers.retrieve(sub.customer)
        const professionalId = customer.metadata?.professional_id
        if (professionalId) {
          await pool.query(
            'UPDATE professionals SET subscription_status = $1 WHERE id = $2',
            [sub.status, professionalId]
          )
        }
        break
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object
        const customer = await stripe.customers.retrieve(sub.customer)
        const professionalId = customer.metadata?.professional_id
        if (professionalId) {
          await pool.query(
            'UPDATE professionals SET subscription_status = $1 WHERE id = $2',
            ['inactive', professionalId]
          )
        }
        break
      }
    }
    res.json({ received: true })
  } catch (err) {
    console.error('Webhook handler error:', err)
    res.status(500).json({ error: 'Webhook handler failed' })
  }
})

export default router
