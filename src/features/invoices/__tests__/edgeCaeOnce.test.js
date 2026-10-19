import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const invoice = {
  id: '11111111-1111-4111-8111-111111111111',
  company_id: '22222222-2222-4222-8222-222222222222',
  tipo_comprobante: 'Factura B', numero_comprobante: 10, total_amount: 121,
}
const sources = [
  'supabase/functions/afip-emit/index.js',
  'scripts/arca/afip-emit.dashboard.js',
]

function setup(path, { failCae = false, failRecord = false, reserveError, rejectCae = false } = {}) {
  const reservations = new Set()
  const records = []
  const cae = vi.fn(async () => {
    if (failCae) throw new Error('network timeout')
    return new Response(rejectCae ? '<Resultado>R</Resultado><Err><Code>1</Code><Msg>Rechazo</Msg></Err>'
      : '<Resultado>A</Resultado><CAE>70000000000001</CAE><CAEFchVto>20261101</CAEFchVto>')
  })
  const fetch = vi.fn(async (url, options = {}) => {
    if (url.includes('/arca_tokens')) return Response.json([{ token: 't', sign: 's', expiration_time: '2099-01-01' }])
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'user-a' })
    if (url.endsWith('/rpc/reserve_invoice_cae')) {
      if (reserveError) return Response.json(reserveError, { status: 400 })
      const { p_invoice_id: id } = JSON.parse(options.body)
      if (reservations.has(id)) return Response.json({ code: '23505', message: 'CAE ya solicitado' }, { status: 409 })
      reservations.add(id)
      return Response.json(null)
    }
    if (url.includes('/invoice_cae_requests?')) {
      const record = JSON.parse(options.body)
      if (failRecord && record.arca_result) return Response.json({ message: 'db caída' }, { status: 503 })
      records.push(record)
      return new Response(null, { status: 204 })
    }
    if (url.includes('wsfev1')) {
      if (options.headers.SOAPAction.endsWith('/FECompUltimoAutorizado')) return new Response('<CbteNro>9</CbteNro>')
      expect(records.some((record) => record.arca_request?.detalle[0].cbteDesde === 10)).toBe(true)
      return cae()
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  const env = {
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only',
    'Arca.crt': '-----BEGIN fake certificate', 'Arca.key': '-----BEGIN fake key', 'Arca.CUIT': '20111111112',
  }
  let handler
  // Execute the actual self-contained entrypoint. WSAA reuses the mocked cached
  // token, so no certificate signing or external network requests are needed.
  const source = readFileSync(path, 'utf8').replace(/^import forge from .*$/m, 'const forge = {}')
  new vm.Script(source, { filename: path }).runInNewContext({
    Deno: { env: { get: (name) => env[name] }, serve: (fn) => { handler = fn } },
    fetch, Response, console: { log: vi.fn(), error: vi.fn() },
  })
  const send = (input = invoice, authorization = 'Bearer user-token') => handler(new Request('https://example.supabase.co/functions/v1/afip-emit', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify({ action: 'cae', invoice: input }),
  }))
  return { send, cae, fetch, records }
}

describe.each(sources)('una sola solicitud de CAE: %s', (source) => {
  it('bloquea llamadas simultáneas y sucesivas con el mismo id', async () => {
    const ctx = setup(source)
    const responses = await Promise.all([ctx.send(), ctx.send()])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    expect((await ctx.send()).status).toBe(409)
    expect(ctx.cae).toHaveBeenCalledOnce()
    expect(ctx.records.find((record) => record.state === 'authorized').arca_result.cae).toBe('70000000000001')
  })

  it.each([{ failCae: true }, { failRecord: true }, { rejectCae: true }])('conserva el bloqueo ante fallas: %j', async (options) => {
    const ctx = setup(source, options)
    expect((await ctx.send()).status).toBe(options.rejectCae ? 422 : options.failRecord ? 503 : 500)
    expect((await ctx.send()).status).toBe(409)
    expect(ctx.cae).toHaveBeenCalledOnce()
  })

  it.each([
    { code: '23505', message: 'La factura ya tiene CAE', status: 409 },
    { code: '42501', message: 'Sin acceso a la empresa', status: 403 },
    { code: 'PGRST202', message: 'Falta la migración', status: 503 },
  ])('no emite si la base rechaza la reserva: %j', async (error) => {
    const ctx = setup(source, { reserveError: error })
    expect((await ctx.send()).status).toBe(error.status)
    expect(ctx.cae).not.toHaveBeenCalled()
  })

  it('no emite sin identificador ni con un CAE existente en el payload', async () => {
    const ctx = setup(source)
    expect((await ctx.send({ ...invoice, id: undefined })).status).toBe(400)
    expect((await ctx.send({ ...invoice, cae: '70000000000001' })).status).toBe(409)
    expect(ctx.fetch).not.toHaveBeenCalled()
  })

  it('exige sesión antes de reservar y emitir', async () => {
    const ctx = setup(source)
    expect((await ctx.send(invoice, null)).status).toBe(401)
    expect(ctx.cae).not.toHaveBeenCalled()
    expect(ctx.fetch.mock.calls.some(([url]) => url.endsWith('/rpc/reserve_invoice_cae'))).toBe(false)
  })
})
