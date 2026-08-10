import { createAfipClient } from '../modules/arca/services/AfipClientFactory.js'
import { ElectronicBillingService } from '../modules/arca/services/ElectronicBillingService.js'
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

    const arcaResult = await this.billing.emitInvoice({ ...invoice, items })
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
