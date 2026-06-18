import express from 'express'
import { v2 as cloudinary } from 'cloudinary'
import { pool } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'
import multer from 'multer'

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const storage = multer.memoryStorage()
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } })

const router = express.Router()

// GET /vault — list documents
router.get('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth
    const proResult = await pool.query('SELECT * FROM professionals WHERE clerk_user_id = $1', [userId])
    if (proResult.rows.length === 0) return res.status(404).json({ error: 'Professional not found' })
    const docs = await pool.query(
      'SELECT * FROM vault_documents WHERE professional_id = $1 ORDER BY uploaded_at DESC',
      [proResult.rows[0].id]
    )
    res.json(docs.rows)
  } catch (err) {
    console.error('GET /vault error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /vault/upload — upload a document
router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { userId } = req.auth
    const { category } = req.body

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

    const proResult = await pool.query('SELECT * FROM professionals WHERE clerk_user_id = $1', [userId])
    if (proResult.rows.length === 0) return res.status(404).json({ error: 'Professional not found' })
    const pro = proResult.rows[0]

    // Upload to Cloudinary
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `supervisd/${pro.id}`,
          resource_type: 'auto',
          use_filename: true,
          unique_filename: true,
        },
        (error, result) => {
          if (error) reject(error)
          else resolve(result)
        }
      )
      stream.end(req.file.buffer)
    })

    const result = uploadResult

    // Save to DB
    const doc = await pool.query(
      `INSERT INTO vault_documents (professional_id, file_name, file_url, file_type, file_size, category)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        pro.id,
        req.file.originalname,
        result.secure_url,
        req.file.mimetype,
        req.file.size,
        category || 'general',
      ]
    )

    res.json({ success: true, document: doc.rows[0] })
  } catch (err) {
    console.error('POST /vault/upload error:', err)
    res.status(500).json({ error: 'Failed to upload file' })
  }
})

// DELETE /vault/:id — delete a document
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth
    const { id } = req.params

    const proResult = await pool.query('SELECT * FROM professionals WHERE clerk_user_id = $1', [userId])
    if (proResult.rows.length === 0) return res.status(404).json({ error: 'Professional not found' })

    const doc = await pool.query(
      'SELECT * FROM vault_documents WHERE id = $1 AND professional_id = $2',
      [id, proResult.rows[0].id]
    )
    if (doc.rows.length === 0) return res.status(404).json({ error: 'Document not found' })

    // Delete from Cloudinary
    const publicId = doc.rows[0].file_url.split('/').slice(-2).join('/').split('.')[0]
    await cloudinary.uploader.destroy(`supervisd/${publicId}`, { resource_type: 'raw' })

    // Delete from DB
    await pool.query('DELETE FROM vault_documents WHERE id = $1', [id])

    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /vault error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
