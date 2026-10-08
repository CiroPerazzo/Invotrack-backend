import { createUserClient } from '../config/supabase.js'

export async function authMiddleware(req, res, next) {
  try {
    const cookie = req.headers.cookie?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith('accessToken='))
    const token = cookie ? decodeURIComponent(cookie.slice('accessToken='.length)) : null
    if (!token) {
      return res.status(401).json({ error: 'Token de autenticación requerido' })
    }

    const db = createUserClient(token)
    const { data: { user }, error } = await db.auth.getUser(token)
    if (error || !user) {
      return res.status(401).json({ error: 'Sesión inválida o expirada' })
    }

    req.user = user
    req.db = db
    next()
  } catch (err) {
    next(err)
  }
}

export async function companyScopeMiddleware(req, res, next) {
  try {
    const companyId = req.params.companyId ?? req.body?.company_id ?? req.headers['x-company-id']
    if (!companyId) {
      return res.status(400).json({ error: 'company_id es requerido' })
    }

    const { data: company, error: companyError } = await req.db
      .from('companies')
      .select('id, owner_id, cuit, name')
      .eq('id', companyId)
      .maybeSingle()
    if (companyError) throw companyError
    if (!company) return res.status(404).json({ error: 'Empresa no encontrada' })

    const isOwner = company.owner_id === req.user.id
    let role = null
    if (!isOwner) {
      const result = await req.db
        .from('user_roles')
        .select('role')
        .eq('company_id', companyId)
        .eq('user_id', req.user.id)
        .maybeSingle()
      if (result.error) throw result.error
      role = result.data?.role
    }
    if (!isOwner && !role) {
      return res.status(403).json({ error: 'No tenés acceso a esta empresa' })
    }

    req.companyId = companyId
    req.company = company
    req.companyRole = isOwner ? 'admin' : role
    next()
  } catch (err) {
    next(err)
  }
}

export function requireCompanyRole(...allowed) {
  return (req, res, next) => {
    if (!allowed.includes(req.companyRole)) {
      return res.status(403).json({ error: 'No tenés permisos para esta operación' })
    }
    next()
  }
}
