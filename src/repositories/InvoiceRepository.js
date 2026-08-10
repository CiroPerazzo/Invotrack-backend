import { supabaseAdmin } from '../config/supabase.js'

export class InvoiceRepository {
  async assertNotDuplicate({ companyId, invoiceNumber, tipoComprobante }) {
    const { data } = await supabaseAdmin
      .from('invoices')
      .select('id')
      .eq('company_id', companyId)
      .eq('invoice_number', invoiceNumber)
      .eq('tipo_comprobante', tipoComprobante)
      .maybeSingle()

    if (data) {
      throw new Error(
        `Ya existe una ${tipoComprobante} con el número ${invoiceNumber} en esta empresa.`
      )
    }
  }

  async createIssuedInvoice({ invoice, items, userId, arcaResult }) {
    const invoiceNumber =
      `${String(arcaResult.puntoDeVenta).padStart(4, '0')}-` +
      `${String(arcaResult.numeroComprobante).padStart(8, '0')}`

    await this.assertNotDuplicate({
      companyId: invoice.company_id,
      invoiceNumber,
      tipoComprobante: invoice.tipo_comprobante,
    })

    const cleanInvoice = { ...invoice }
    delete cleanInvoice.consumidor_final_anonimo
    delete cleanInvoice.__emitMode
    delete cleanInvoice.items

    if (!cleanInvoice.fecha_vencimiento) cleanInvoice.fecha_vencimiento = null

    const row = {
      ...cleanInvoice,
      invoice_number: invoiceNumber,
      numero_comprobante: arcaResult.numeroComprobante,
      punto_de_venta: arcaResult.puntoDeVenta,
      cae: arcaResult.cae,
      cae_vencimiento: arcaResult.caeVencimiento,
      afip_status: 'issued',
      status: 'pending',
      user_id: userId,
    }

    const { data: newInvoice, error: invError } = await supabaseAdmin
      .from('invoices')
      .insert(row)
      .select()
      .single()

    if (invError) throw invError

    if (items?.length > 0) {
      const itemRows = items.map((item, idx) => ({
        invoice_id: newInvoice.id,
        sort_order: idx,
        description: item.description ?? item.descripcion ?? '',
        quantity: item.quantity ?? item.cantidad ?? 1,
        unit_price: item.unit_price ?? item.precio_unitario ?? 0,
        iva_rate: item.alicuota_iva ?? item.iva_rate ?? 21,
        subtotal: item.subtotal_neto ?? item.subtotal ?? 0,
      }))

      const { error: itemsError } = await supabaseAdmin
        .from('invoice_items')
        .insert(itemRows)

      if (itemsError) {
        await supabaseAdmin.from('invoices').delete().eq('id', newInvoice.id)
        throw itemsError
      }
    }

    return newInvoice
  }
}
