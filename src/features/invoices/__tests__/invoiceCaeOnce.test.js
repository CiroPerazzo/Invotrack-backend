import { describe, expect, it, vi } from 'vitest'

vi.mock('@/config/supabase.js', () => ({ createAdminClient: vi.fn() }))
const { InvoiceEmitService } = await import('@/modules/invoices/services/InvoiceEmitService.js')
const { ElectronicBillingService } = await import('@/modules/arca/services/ElectronicBillingService.js')

const invoice = {
  id: '11111111-1111-4111-8111-111111111111',
  company_id: '22222222-2222-4222-8222-222222222222',
  type: 'receivable', tipo_comprobante: 'Factura B', total_amount: 121,
}
const result = { cae: '70000000000001', numeroComprobante: 10, puntoDeVenta: 1 }

function context() {
  const reserved = new Set()
  const repo = {
    reserveCae: vi.fn(async ({ invoiceId }) => {
      if (reserved.has(invoiceId)) throw Object.assign(new Error('CAE ya solicitado'), { status: 409 })
      reserved.add(invoiceId)
    }),
    recordCaeRequest: vi.fn(async () => {}),
    recordCaeResult: vi.fn(async () => {}),
    createIssuedInvoice: vi.fn(async ({ invoice }) => ({ ...invoice, cae: result.cae })),
  }
  const createVoucher = vi.fn(async () => ({ CAE: result.cae }))
  const billing = new ElectronicBillingService(() => ({
    ElectronicBilling: { getLastVoucher: vi.fn(async () => 9), createVoucher },
  }))
  return { repo, billing, createVoucher, emit: () => new InvoiceEmitService({ repo, billing }).emit({ invoice, userId: 'user-a' }) }
}

describe('una sola solicitud de CAE por factura (Express)', () => {
  it('persiste el pedido antes de emitir y el CAE antes de guardar la factura', async () => {
    const ctx = context()
    ctx.createVoucher.mockImplementation(async () => {
      expect(ctx.repo.reserveCae).toHaveBeenCalledOnce()
      expect(ctx.repo.recordCaeRequest).toHaveBeenCalledWith(expect.objectContaining({
        invoiceId: invoice.id, request: expect.objectContaining({ CbteDesde: 10 }),
      }))
      return { CAE: result.cae }
    })
    ctx.repo.createIssuedInvoice.mockImplementation(async () => {
      expect(ctx.repo.recordCaeResult).toHaveBeenCalledOnce()
      return { ...invoice, cae: result.cae }
    })
    expect((await ctx.emit()).arca.cae).toBe(result.cae)
  })

  it('dos instancias simultáneas y un reintento posterior solo llaman una vez a ARCA', async () => {
    const ctx = context()
    const responses = await Promise.allSettled([ctx.emit(), ctx.emit()])
    expect(responses.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(responses.find((r) => r.status === 'rejected').reason.status).toBe(409)
    await expect(ctx.emit()).rejects.toMatchObject({ status: 409 })
    expect(ctx.createVoucher).toHaveBeenCalledOnce()
  })

  it.each(['timeout', 'rechazo de ARCA', 'respuesta incompleta'])('no vuelve a emitir después de %s', async (failure) => {
    const ctx = context()
    ctx.createVoucher.mockImplementation(async () => {
      if (failure === 'timeout') throw new Error('network timeout')
      return failure === 'rechazo de ARCA' ? { Errors: ['Rechazado'] } : {}
    })
    await expect(ctx.emit()).rejects.toThrow()
    await expect(ctx.emit()).rejects.toMatchObject({ status: 409 })
    expect(ctx.createVoucher).toHaveBeenCalledOnce()
  })

  it.each(['recordCaeResult', 'createIssuedInvoice'])('no vuelve a emitir si falla %s después de autorizar', async (method) => {
    const ctx = context()
    ctx.repo[method].mockRejectedValue(new Error('persistencia fallida'))
    await expect(ctx.emit()).rejects.toThrow('persistencia fallida')
    await expect(ctx.emit()).rejects.toMatchObject({ status: 409 })
    expect(ctx.createVoucher).toHaveBeenCalledOnce()
  })

  it('no llama a ARCA si falla el registro previo del pedido', async () => {
    const ctx = context()
    ctx.repo.recordCaeRequest.mockRejectedValue(new Error('db no disponible'))
    await expect(ctx.emit()).rejects.toThrow('db no disponible')
    expect(ctx.createVoucher).not.toHaveBeenCalled()
  })

  it.each([
    { ...invoice, id: undefined },
    { ...invoice, cae: result.cae },
    { ...invoice, afip_status: 'issued' },
  ])('rechaza una factura sin identidad o que ya tiene CAE: %j', async (input) => {
    const ctx = context()
    await expect(new InvoiceEmitService(ctx).emit({ invoice: input, userId: 'user-a' })).rejects.toThrow()
    expect(ctx.repo.reserveCae).not.toHaveBeenCalled()
    expect(ctx.createVoucher).not.toHaveBeenCalled()
  })

  it('permite emitir dos facturas distintas con los mismos importes', async () => {
    const ctx = context()
    await ctx.emit()
    await new InvoiceEmitService(ctx).emit({ invoice: { ...invoice, id: '33333333-3333-4333-8333-333333333333' }, userId: 'user-a' })
    expect(ctx.createVoucher).toHaveBeenCalledTimes(2)
  })
})
