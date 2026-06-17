import express from 'express'
import { pool } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()

router.post('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth
    const { email } = req.body
    if (!email) return res.status(400).json({ error: 'Email is required' })

    const proResult = await pool.query('SELECT * FROM professionals WHERE clerk_user_id = $1', [userId])
    if (proResult.rows.length === 0) return res.status(404).json({ error: 'Professional record not found' })
    const inviter = proResult.rows[0]
    if (inviter.role !== 'bcba') return res.status(403).json({ error: 'Only BCBAs can send invites' })

    const existing = await pool.query('SELECT * FROM invites WHERE invitee_email = $1 AND status = $2', [email.toLowerCase(), 'pending'])
    if (existing.rows.length > 0) return res.status(409).json({ error: 'An invite has already been sent to this email' })

    const clerkRes = await fetch('https://api.clerk.com/v1/invitations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.CLERK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email_address: email.toLowerCase(),
        redirect_url: `${process.env.FRONTEND_URL || 'https://supervisd.com'}/sign-up`,
        public_metadata: { inviter_professional_id: inviter.id, inviter_name: inviter.full_name },
        notify: true,
      }),
    })
    const clerkData = await clerkRes.json()
    if (!clerkRes.ok) {
      if (clerkData?.errors?.[0]?.code === 'duplicate_record') return res.status(409).json({ error: 'This email already has a pending invitation' })
      return res.status(500).json({ error: clerkData?.errors?.[0]?.message || 'Failed to send invite' })
    }

    const insertResult = await pool.query(
      "INSERT INTO invites (inviter_professional_id, invitee_email, clerk_invitation_id, status) VALUES ($1, $2, $3, 'pending') RETURNING *",
      [inviter.id, email.toLowerCase(), clerkData.id]
    )
    res.json({ success: true, invite: insertResult.rows[0] })
  } catch (err) {
    console.error('POST /invites error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth
    const proResult = await pool.query('SELECT * FROM professionals WHERE clerk_user_id = $1', [userId])
    if (proResult.rows.length === 0) return res.status(404).json({ error: 'Professional record not found' })
    const invites = await pool.query('SELECT * FROM invites WHERE inviter_professional_id = $1 ORDER BY created_at DESC', [proResult.rows[0].id])
    res.json(invites.rows)
  } catch (err) {
    console.error('GET /invites error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth
    const { id } = req.params
    const proResult = await pool.query('SELECT * FROM professionals WHERE clerk_user_id = $1', [userId])
    if (proResult.rows.length === 0) return res.status(404).json({ error: 'Professional record not found' })
    const invite = await pool.query('SELECT * FROM invites WHERE id = $1 AND inviter_professional_id = $2', [id, proResult.rows[0].id])
    if (invite.rows.length === 0) return res.status(404).json({ error: 'Invite not found' })
    if (invite.rows[0].clerk_invitation_id) {
      await fetch(`https://api.clerk.com/v1/invitations/${invite.rows[0].clerk_invitation_id}/revoke`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.CLERK_SECRET_KEY}` },
      })
    }
    await pool.query('UPDATE invites SET status = $1 WHERE id = $2', ['revoked', id])
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /invites error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
