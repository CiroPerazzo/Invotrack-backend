import { createClient } from '@supabase/supabase-js'
import { env } from '../config/env.js'

/**
 * Valida JWT de Supabase y adjunta user a req.
 */
export async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token de autenticación requerido' })
    }

    const token = header.slice(7)
    const supabase = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
      auth: { persistSession: false },
    })

    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) {
      return res.status(401).json({ error: 'Sesión inválida o expirada' })
    }

    req.user = user
    req.accessToken = token
    next()
  } catch (err) {
    next(err)
  }
}

/**
 * Verifica que el usuario pertenezca a la empresa indicada.
 */
export async function companyScopeMiddleware(req, res, next) {
  try {
    const companyId = req.body?.company_id ?? req.headers['x-company-id']
    if (!companyId) {
      return res.status(400).json({ error: 'company_id es requerido' })
    }

    const { supabaseAdmin } = await import('../config/supabase.js')

    const { data: company } = await supabaseAdmin
      .from('companies')
      .select('id, owner_id, cuit, name')
      .eq('id', companyId)
      .maybeSingle()

    if (!company) {
      return res.status(404).json({ error: 'Empresa no encontrada' })
    }

    const isOwner = company.owner_id === req.user.id

    const { data: role } = await supabaseAdmin
      .from('user_roles')
      .select('role')
      .eq('company_id', companyId)
      .eq('user_id', req.user.id)
      .maybeSingle()

    if (!isOwner && !role) {
      return res.status(403).json({ error: 'No tenés acceso a esta empresa' })
    }

    req.companyId = companyId
    req.company = company
    next()
  } catch (err) {
    next(err)
  }
}
