import { InvoiceEmitService } from '../modules/invoices/services/InvoiceEmitService.js'

const emitService = new InvoiceEmitService()

export const invoiceController = {
  async emit(req, res, next) {
    try {
      const { items = [], ...invoiceFields } = req.body ?? {}

      const result = await emitService.emit({
        invoice: {
          ...invoiceFields,
          company_id: req.companyId,
          emisor_cuit: invoiceFields.emisor_cuit || req.company?.cuit,
        },
        items,
        userId: req.user.id,
      })

      res.status(201).json(result)
    } catch (err) {
      err.status = err.message?.includes('ARCA') ? 422 : 400
      next(err)
    }
  },

  async health(_req, res) {
    res.json({ ok: true, service: 'invotrack-api' })
  },
}
