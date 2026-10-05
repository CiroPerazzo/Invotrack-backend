import { Router } from 'express'
import { z } from 'zod'
import { authMiddleware, companyScopeMiddleware, requireCompanyRole } from '../middleware/authMiddleware.js'

const uuid = z.string().uuid()
const optionalText = z.string().max(500).nullable().optional()
const partyFields = {
  name: z.string().trim().min(2).max(200),
  cuit: z.string().regex(/^\d{2}-\d{8}-\d$/).or(z.literal('')).nullable().optional(),
  email: z.email().or(z.literal('')).nullable().optional(),
  phone: optionalText,
  address: optionalText,
  tax_condition: z.enum(['RI', 'MO', 'EX', 'CF', 'RS']).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
}

const schemas = {
  clients: z.strictObject(partyFields),
  providers: z.strictObject(partyFields),
  products: z.strictObject({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(5000).nullable().optional(),
    price: z.coerce.number().finite().nonnegative(),
    unit: z.string().max(30).optional(),
    stock: z.coerce.number().finite().nonnegative().optional(),
    provider_id: uuid.nullable().optional(),
  }),
}

const router = Router()
router.use(authMiddleware)

function resource(req, res, next) {
  const table = req.params.resource
  if (!uuid.safeParse(req.params.companyId).success) {
    return res.status(400).json({ error: 'companyId inválido' })
  }
  if (!Object.hasOwn(schemas, table)) {
    return res.status(404).json({ error: 'Recurso no encontrado' })
  }
  req.table = table
  next()
}

function validateId(req, res, next) {
  if (!uuid.safeParse(req.params.id).success) {
    return res.status(400).json({ error: 'ID inválido' })
  }
  next()
}

function parsePayload(req, res, next) {
  const schema = req.method === 'POST' ? schemas[req.table] : schemas[req.table].partial()
  const result = schema.safeParse(req.body)
  if (!result.success || (req.method !== 'POST' && Object.keys(result.data).length === 0)) {
    return res.status(400).json({ error: 'Datos inválidos', details: result.error?.flatten() })
  }
  req.payload = result.data
  next()
}

async function validateProvider(req, res, next) {
  try {
    const providerId = req.payload.provider_id
    if (req.table !== 'products' || !providerId) return next()
    const { data, error } = await req.db.from('providers')
      .select('id').eq('company_id', req.companyId).eq('id', providerId).maybeSingle()
    if (error) throw error
    if (!data) return res.status(400).json({ error: 'El proveedor no pertenece a esta empresa' })
    next()
  } catch (err) {
    next(err)
  }
}

router.use('/companies/:companyId/:resource', resource, companyScopeMiddleware)

router.get('/companies/:companyId/:resource', async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1)
    const pageSize = Number(req.query.pageSize ?? (req.table === 'products' ? 50 : 20))
    const search = String(req.query.search ?? '').trim()
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || search.length > 200) {
      return res.status(400).json({ error: 'Filtros inválidos' })
    }

    const select = req.table === 'products' ? '*, provider:providers(id, name)' : '*'
    let query = req.db.from(req.table).select(select, { count: 'exact' })
      .eq('company_id', req.companyId).order('name', { ascending: true })
      .range((page - 1) * pageSize, page * pageSize - 1)
    if (search) query = query.ilike('name', `%${search}%`)
    const { data, count, error } = await query
    if (error) throw error
    res.json({ data: data ?? [], count: count ?? 0 })
  } catch (err) {
    next(err)
  }
})

router.get('/companies/:companyId/:resource/:id', validateId, async (req, res, next) => {
  try {
    const select = req.table === 'products' ? '*, provider:providers(id, name)' : '*'
    const { data, error } = await req.db.from(req.table).select(select)
      .eq('company_id', req.companyId).eq('id', req.params.id).maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Registro no encontrado' })
    res.json(data)
  } catch (err) {
    next(err)
  }
})

router.post('/companies/:companyId/:resource', requireCompanyRole('admin', 'accountant'), parsePayload, validateProvider, async (req, res, next) => {
  try {
    const { data, error } = await req.db.from(req.table)
      .insert({ ...req.payload, company_id: req.companyId, user_id: req.user.id })
      .select().single()
    if (error) throw error
    res.status(201).json(data)
  } catch (err) {
    next(err)
  }
})

router.patch('/companies/:companyId/:resource/:id', requireCompanyRole('admin', 'accountant'), validateId, parsePayload, validateProvider, async (req, res, next) => {
  try {
    const { data, error } = await req.db.from(req.table)
      .update(req.payload).eq('company_id', req.companyId).eq('id', req.params.id)
      .select().maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Registro no encontrado' })
    res.json(data)
  } catch (err) {
    next(err)
  }
})

router.delete('/companies/:companyId/:resource/:id', requireCompanyRole('admin'), validateId, async (req, res, next) => {
  try {
    const { data, error } = await req.db.from(req.table).delete()
      .eq('company_id', req.companyId).eq('id', req.params.id).select('id').maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Registro no encontrado' })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

export default router
