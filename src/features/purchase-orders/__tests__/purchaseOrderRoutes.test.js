import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { state, db } = vi.hoisted(() => {
  const state = { rows: [] }
  const query = {
    select: vi.fn(function () { return this }),
    eq: vi.fn(function () { return this }),
    in: vi.fn(async () => ({ data: state.rows, error: null })),
  }
  return { state, db: { from: vi.fn(() => query), rpc: vi.fn(async () => ({ data: 'created-id', error: null })) } }
})
vi.mock('@/middleware/authMiddleware.js', () => ({
  authMiddleware: (req, _res, next) => { req.db = db; req.user = { id: 'user-id' }; next() },
  companyScopeMiddleware: (req, _res, next) => { req.companyId = req.params.companyId; next() },
  requireCompanyRole: () => (_req, _res, next) => next(),
}))
const { default: routes } = await import('@/routes/purchaseOrderRoutes.js')
const companyId = '11111111-1111-4111-8111-111111111111'
const a = '22222222-2222-4222-8222-222222222222'
const b = '33333333-3333-4333-8333-333333333333'
let server, base
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use(routes)
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}/companies/${companyId}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))
beforeEach(() => { vi.clearAllMocks(); state.rows = [] })
const post = (path, body) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('órdenes de compra', () => {
  it('rechaza órdenes repetidas antes de agruparlas', async () => {
    const response = await post('purchase-orders/group-preview', { orderIds: [a, a] })
    expect(response.status).toBe(400)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('rechaza agrupar proveedores distintos', async () => {
    state.rows = [
      { id: a, provider_id: a, status: 'pending', remaining_amount: 100 },
      { id: b, provider_id: b, status: 'pending', remaining_amount: 200 },
    ]
    const response = await post('purchase-orders/group-preview', { orderIds: [a, b] })
    expect(response.status).toBe(400)
    expect(db.from).toHaveBeenCalledWith('purchase_order_progress')
  })

  it('envía todas las asignaciones a una operación atómica', async () => {
    const response = await post(`invoices/${b}/purchase-orders`, {
      allocations: [{ purchase_order_id: a, allocated_amount: 100 }],
    })
    expect(response.status).toBe(204)
    expect(db.rpc).toHaveBeenCalledWith('allocate_purchase_orders', {
      p_company_id: companyId, p_invoice_id: b,
      p_allocations: [{ purchase_order_id: a, allocated_amount: 100 }],
    })
  })

  it('no acepta dos asignaciones de la misma orden a una factura', async () => {
    const response = await post(`invoices/${b}/purchase-orders`, {
      allocations: [
        { purchase_order_id: a, allocated_amount: 100 },
        { purchase_order_id: a, allocated_amount: 50 },
      ],
    })
    expect(response.status).toBe(400)
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('crea factura e ítems agrupados con una sola llamada transaccional', async () => {
    const payload = {
      invoice: { type: 'payable', provider_id: b, total_amount: 100 },
      items: [{ description: 'Orden OC-1', quantity: 1, unit_price: 100, alicuota_iva: 0 }],
      allocations: [{ purchase_order_id: a, allocated_amount: 100 }],
    }
    const response = await post('purchase-orders/grouped-invoice', payload)
    expect(response.status).toBe(201)
    expect(db.rpc).toHaveBeenCalledWith('create_grouped_purchase_invoice', {
      p_company_id: companyId,
      p_invoice: payload.invoice,
      p_items: payload.items,
      p_allocations: payload.allocations,
    })
  })
})
