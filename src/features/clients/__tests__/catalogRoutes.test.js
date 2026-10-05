import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { db, state } = vi.hoisted(() => {
  const state = { provider: null }
  const query = {
    select: vi.fn(function () { return this }),
    eq: vi.fn(function () { return this }),
    insert: vi.fn(function () { return this }),
    update: vi.fn(function () { return this }),
    maybeSingle: vi.fn(async () => ({ data: state.provider, error: null })),
    single: vi.fn(async () => ({ data: { id: 'created' }, error: null })),
  }
  return { state, db: { from: vi.fn(() => query), query } }
})
vi.mock('@/middleware/authMiddleware.js', () => ({
  authMiddleware: (req, res, next) => { req.db = db; req.user = { id: 'user' }; next() },
  companyScopeMiddleware: (req, res, next) => { req.companyId = req.params.companyId; next() },
  requireCompanyRole: () => (req, res, next) => next(),
}))
const { default: routes } = await import('@/routes/catalogRoutes.js')
const companyId = '11111111-1111-4111-8111-111111111111'
const providerId = '22222222-2222-4222-8222-222222222222'
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
beforeEach(() => { vi.clearAllMocks(); state.provider = null })
async function send(resource, body, method = 'POST') {
  return fetch(`${base}/${resource}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
describe('validaci?n de proveedor en productos', () => {
  it.each([undefined, null, '', 'invalid'])('rechaza crear sin proveedor v?lido: %s', async (provider_id) => {
    const response = await send('products', { name: 'Motor', price: 100, provider_id })
    expect(response.status).toBe(400)
    expect(db.query.insert).not.toHaveBeenCalled()
  })
  it('rechaza un proveedor inexistente o de otra empresa', async () => {
    expect((await send('products', { name: 'Motor', price: 100, provider_id: providerId })).status).toBe(400)
    expect(db.query.eq).toHaveBeenCalledWith('company_id', companyId)
    expect(db.query.insert).not.toHaveBeenCalled()
  })
  it('crea cuando el proveedor pertenece a la empresa', async () => {
    state.provider = { id: providerId }
    expect((await send('products', { name: 'Motor', price: 100, provider_id: providerId })).status).toBe(201)
    expect(db.query.insert).toHaveBeenCalledWith(expect.objectContaining({ company_id: companyId, provider_id: providerId }))
  })
  it('permite una actualizaci?n parcial sin cambiar el proveedor', async () => {
    state.provider = { id: providerId }
    expect((await send(`products/${providerId}`, { name: 'Nuevo nombre' }, 'PATCH')).status).toBe(200)
    expect(db.query.update).toHaveBeenCalledWith({ name: 'Nuevo nombre' })
  })
  it('impide quitar el proveedor mediante PATCH', async () => {
    expect((await send(`products/${providerId}`, { provider_id: null }, 'PATCH')).status).toBe(400)
    expect(db.query.update).not.toHaveBeenCalled()
  })
})
