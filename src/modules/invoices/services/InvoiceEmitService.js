import { createAfipClient } from '../../arca/services/AfipClientFactory.js'
import { ElectronicBillingService } from '../../arca/services/ElectronicBillingService.js'
import { InvoiceRepository } from '../../../repositories/InvoiceRepository.js'

export class InvoiceEmitService {
  constructor(deps = {}) {
    this.billing = deps.billing ?? new ElectronicBillingService(createAfipClient)
    this.repo = deps.repo ?? new InvoiceRepository()
  }

  /**
   * Emite factura en ARCA y persiste en Supabase con CAE.
   * @param {{ invoice: object, items: object[], userId: string }} params
   */
  async emit({ invoice, items = [], userId }) {
    if (!invoice?.company_id) {
      throw new Error('company_id es requerido')
    }
    if (invoice.type !== 'receivable') {
      throw new Error('Solo se pueden emitir facturas de venta (receivable) con ARCA')
    }

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invoice.id ?? '')) {
      throw new Error('invoice.id debe ser un UUID estable para solicitar el CAE una sola vez')
    }
    if (String(invoice.cae ?? '').trim() || ['issued', 'authorized', 'valid'].includes(invoice.afip_status)) {
      throw Object.assign(new Error('Esta factura ya tiene un CAE. No se puede solicitar otro.'), { status: 409 })
    }

    // Reserve durably before calling ARCA. Never release this reservation on
    // errors: a timeout can hide a successful authorization.
    await this.repo.reserveCae({ invoiceId: invoice.id, companyId: invoice.company_id, userId })
    const arcaResult = await this.billing.emitInvoice({ ...invoice, items }, {
      beforeRequest: (request) => this.repo.recordCaeRequest({
        invoiceId: invoice.id, companyId: invoice.company_id, request,
      }),
    })
    await this.repo.recordCaeResult({ invoiceId: invoice.id, companyId: invoice.company_id, arcaResult })
    const saved = await this.repo.createIssuedInvoice({
      invoice,
      items,
      userId,
      arcaResult,
    })

    return {
      invoice: saved,
      arca: {
        cae: arcaResult.cae,
        caeVencimiento: arcaResult.caeVencimiento,
        numeroComprobante: arcaResult.numeroComprobante,
        puntoDeVenta: arcaResult.puntoDeVenta,
      },
    }
  }
}
