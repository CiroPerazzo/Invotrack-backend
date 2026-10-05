import { describe, expect, it, vi } from 'vitest'

process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_ANON_KEY = 'test-key'

const { companyScopeMiddleware, requireCompanyRole } = await import('@/middleware/authMiddleware.js')

function query(result) {
  return {
    select() { return this },
    eq() { return this },
    async maybeSingle() { return { data: result, error: null } },
  }
}

function request({ company, role }) {
  const req = {
    params: { companyId: '11111111-1111-4111-8111-111111111111' },
    user: { id: 'user-a' },
    db: { from: vi.fn((table) => query(table === 'companies' ? company : role)) },
  }
  const res = {
    status: vi.fn(function (code) { this.code = code; return this }),
    json: vi.fn(function (body) { this.body = body; return this }),
  }
  return { req, res, next: vi.fn() }
}

describe('aislamiento del backend por empresa', () => {
  it('reconoce al propietario como admin', async () => {
    const ctx = request({ company: { id: 'company-a', owner_id: 'user-a' } })
    await companyScopeMiddleware(ctx.req, ctx.res, ctx.next)
    expect(ctx.next).toHaveBeenCalledOnce()
    expect(ctx.req.companyRole).toBe('admin')
    expect(ctx.req.db.from).toHaveBeenCalledWith('companies')
    expect(ctx.req.db.from).not.toHaveBeenCalledWith('user_roles')
  })

  it('impide el acceso si el usuario no pertenece a la empresa', async () => {
    const ctx = request({ company: { id: 'company-a', owner_id: 'user-b' }, role: null })
    await companyScopeMiddleware(ctx.req, ctx.res, ctx.next)
    expect(ctx.res.status).toHaveBeenCalledWith(403)
    expect(ctx.next).not.toHaveBeenCalled()
  })

  it('permite lectura a viewer y rechaza escritura', async () => {
    const ctx = request({ company: { id: 'company-a', owner_id: 'user-b' }, role: { role: 'viewer' } })
    await companyScopeMiddleware(ctx.req, ctx.res, ctx.next)
    expect(ctx.req.companyRole).toBe('viewer')
    const writeNext = vi.fn()
    requireCompanyRole('admin', 'accountant')(ctx.req, ctx.res, writeNext)
    expect(ctx.res.status).toHaveBeenCalledWith(403)
    expect(writeNext).not.toHaveBeenCalled()
  })
})
