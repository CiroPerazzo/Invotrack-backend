import { Router } from 'express'
import { z } from 'zod'
import { authMiddleware, companyScopeMiddleware, requireCompanyRole } from '../middleware/authMiddleware.js'

const uuid = z.string().uuid()
const item = z.strictObject({
  product_id: uuid.nullable().optional(),
  description: z.string().trim().min(1).max(500),
  quantity: z.coerce.number().finite().positive().max(1000000),
  unit_price: z.coerce.number().finite().nonnegative().max(100000000000),
  iva_rate: z.coerce.number().refine((rate) => [0, 10.5, 21, 27].includes(rate)).default(0),
})
const order = z.strictObject({
  provider_id: uuid,
  order_number: z.string().trim().min(1).max(80),
  issue_date: z.iso.date(),
  status: z.enum(['draft', 'pending', 'cancelled']),
  notes: z.string().max(5000).nullable().optional(),
  items: z.array(item).min(1).max(100),
})
const allocation = z.strictObject({
  purchase_order_id: uuid,
  allocated_amount: z.coerce.number().finite().positive().max(9999999999999.99),
})
const router = Router()
router.use(authMiddleware)
router.use('/companies/:companyId', (req, res, next) => {
  if (!uuid.safeParse(req.params.companyId).success) return res.status(400).json({ error: 'companyId inválido' })
  next()
}, companyScopeMiddleware)

function parse(schema, value, res) {
  const result = schema.safeParse(value)
  if (!result.success) {
    res.status(400).json({ error: 'Datos inválidos', details: result.error.flatten() })
    return null
  }
  return result.data
}

router.get('/companies/:companyId/purchase-orders', async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1)
    const pageSize = Number(req.query.pageSize ?? 20)
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return res.status(400).json({ error: 'Paginación inválida' })
    }
    const { data, count, error } = await req.db.from('purchase_order_progress')
      .select('*', { count: 'exact' }).eq('company_id', req.companyId)
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1)
    if (error) throw error
    res.json({ data: data ?? [], count: count ?? 0 })
  } catch (err) { next(err) }
})

router.get('/companies/:companyId/purchase-orders/:id', async (req, res, next) => {
  try {
    if (!uuid.safeParse(req.params.id).success) return res.status(400).json({ error: 'ID inválido' })
    const { data: orderData, error } = await req.db.from('purchase_order_progress')
      .select('*').eq('company_id', req.companyId).eq('id', req.params.id).maybeSingle()
    if (error) throw error
    if (!orderData) return res.status(404).json({ error: 'Orden no encontrada' })
    const [items, links] = await Promise.all([
      req.db.from('purchase_order_items').select('*').eq('purchase_order_id', req.params.id).order('sort_order'),
      req.db.from('purchase_order_invoices').select('invoice_id, allocated_amount, invoices(id, invoice_number, total_amount, status)')
        .eq('company_id', req.companyId).eq('purchase_order_id', req.params.id),
    ])
    if (items.error) throw items.error
    if (links.error) throw links.error
    res.json({ ...orderData, items: items.data ?? [], invoices: links.data ?? [] })
  } catch (err) { next(err) }
})

async function save(req, res, next) {
  try {
    const payload = parse(order, req.body, res)
    if (!payload) return
    if (req.params.id && !uuid.safeParse(req.params.id).success) return res.status(400).json({ error: 'ID inválido' })
    const { data: id, error } = await req.db.rpc('save_purchase_order', {
      p_company_id: req.companyId,
      p_order_id: req.params.id ?? null,
      p_provider_id: payload.provider_id,
      p_order_number: payload.order_number,
      p_issue_date: payload.issue_date,
      p_status: payload.status,
      p_notes: payload.notes ?? null,
      p_items: payload.items,
    })
    if (error) throw error
    res.status(req.params.id ? 200 : 201).json({ id })
  } catch (err) { next(err) }
}
router.post('/companies/:companyId/purchase-orders', requireCompanyRole('admin', 'accountant'), save)
router.put('/companies/:companyId/purchase-orders/:id', requireCompanyRole('admin', 'accountant'), save)

router.patch('/companies/:companyId/purchase-orders/:id/cancel', requireCompanyRole('admin', 'accountant'), async (req, res, next) => {
  try {
    if (!uuid.safeParse(req.params.id).success) return res.status(400).json({ error: 'ID inválido' })
    const { data, error } = await req.db.from('purchase_orders').update({ status: 'cancelled' })
      .eq('company_id', req.companyId).eq('id', req.params.id).select('id').maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Orden no encontrada' })
    res.status(204).end()
  } catch (err) { next(err) }
})

router.delete('/companies/:companyId/purchase-orders/:id', requireCompanyRole('admin'), async (req, res, next) => {
  try {
    if (!uuid.safeParse(req.params.id).success) return res.status(400).json({ error: 'ID inválido' })
    const { data, error } = await req.db.from('purchase_orders').delete()
      .eq('company_id', req.companyId).eq('id', req.params.id).select('id').maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Orden no encontrada' })
    res.status(204).end()
  } catch (err) { next(err) }
})

router.post('/companies/:companyId/purchase-orders/group-preview', async (req, res, next) => {
  try {
    const ids = parse(z.array(uuid).min(1).max(100), req.body?.orderIds, res)
    if (!ids) return
    if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'Órdenes duplicadas' })
    const { data, error } = await req.db.from('purchase_order_progress').select('*')
      .eq('company_id', req.companyId).in('id', ids)
    if (error) throw error
    const rows = data ?? []
    if (rows.length !== ids.length || rows.some((row) => row.status !== 'pending' || Number(row.remaining_amount) <= 0)
        || new Set(rows.map((row) => row.provider_id)).size !== 1) {
      return res.status(400).json({ error: 'Seleccioná órdenes pendientes de la misma empresa y proveedor con saldo disponible' })
    }
    res.json({ provider_id: rows[0].provider_id, orders: rows,
      total_remaining: rows.reduce((sum, row) => sum + Number(row.remaining_amount), 0) })
  } catch (err) { next(err) }
})

router.post('/companies/:companyId/invoices/:invoiceId/purchase-orders', requireCompanyRole('admin', 'accountant'), async (req, res, next) => {
  try {
    if (!uuid.safeParse(req.params.invoiceId).success) return res.status(400).json({ error: 'ID inválido' })
    const allocations = parse(z.array(allocation).min(1).max(100), req.body?.allocations, res)
    if (!allocations) return
    if (new Set(allocations.map((entry) => entry.purchase_order_id)).size !== allocations.length) {
      return res.status(400).json({ error: 'Órdenes duplicadas' })
    }
    const { error } = await req.db.rpc('allocate_purchase_orders', {
      p_company_id: req.companyId, p_invoice_id: req.params.invoiceId, p_allocations: allocations,
    })
    if (error) throw error
    res.status(204).end()
  } catch (err) { next(err) }
})

router.post('/companies/:companyId/purchase-orders/grouped-invoice', requireCompanyRole('admin', 'accountant'), async (req, res, next) => {
  try {
    const payload = parse(z.strictObject({
      invoice: z.record(z.string(), z.unknown()),
      items: z.array(z.strictObject({
        description: z.string().trim().min(1).max(500),
        quantity: z.coerce.number().finite().positive(),
        unidad: z.string().max(30).nullable().optional(),
        unit_price: z.coerce.number().finite().positive(),
        alicuota_iva: z.coerce.number().refine((rate) => [0, 10.5, 21, 27].includes(rate)),
      })).min(1).max(100),
      allocations: z.array(allocation).min(1).max(100),
    }), req.body, res)
    if (!payload) return
    if (payload.invoice.type !== 'payable' || !uuid.safeParse(payload.invoice.provider_id).success
        || !Number.isFinite(Number(payload.invoice.total_amount)) || Number(payload.invoice.total_amount) <= 0
        || new Set(payload.allocations.map((entry) => entry.purchase_order_id)).size !== payload.allocations.length) {
      return res.status(400).json({ error: 'Factura agrupada inválida' })
    }
    const { data: id, error } = await req.db.rpc('create_grouped_purchase_invoice', {
      p_company_id: req.companyId, p_invoice: payload.invoice,
      p_items: payload.items, p_allocations: payload.allocations,
    })
    if (error) throw error
    res.status(201).json({ id })
  } catch (err) { next(err) }
})

router.get('/companies/:companyId/invoices/:invoiceId/purchase-orders', async (req, res, next) => {
  try {
    if (!uuid.safeParse(req.params.invoiceId).success) return res.status(400).json({ error: 'ID inválido' })
    const { data, error } = await req.db.from('purchase_order_invoices')
      .select('purchase_order_id, allocated_amount, purchase_orders(id, order_number, provider_id)')
      .eq('company_id', req.companyId).eq('invoice_id', req.params.invoiceId)
    if (error) throw error
    res.json(data ?? [])
  } catch (err) { next(err) }
})

export default router
