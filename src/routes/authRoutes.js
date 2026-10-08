import { Router } from 'express'
import { createUserClient } from '../config/supabase.js'
import { env } from '../config/env.js'

const router = Router()
const cookieOptions = {
  httpOnly: true,
  secure: env.nodeEnv === 'production',
  sameSite: 'lax',
  path: '/api/v1',
}

router.post('/auth/session', async (req, res, next) => {
  try {
    const token = req.body?.accessToken
    if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'Token requerido' })

    const { data: { user }, error } = await createUserClient(token).auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: 'Sesión inválida o expirada' })

    let expiresAt
    try {
      expiresAt = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).exp
    } catch {
      return res.status(401).json({ error: 'Sesión inválida o expirada' })
    }
    const maxAge = Math.max(0, expiresAt * 1000 - Date.now())
    if (!Number.isFinite(maxAge) || maxAge === 0) {
      return res.status(401).json({ error: 'Sesión inválida o expirada' })
    }

    res.cookie('accessToken', token, { ...cookieOptions, maxAge })
    return res.status(204).end()
  } catch (err) {
    next(err)
  }
})

router.delete('/auth/session', (_req, res) => {
  res.clearCookie('accessToken', cookieOptions)
  res.status(204).end()
})

export default router
