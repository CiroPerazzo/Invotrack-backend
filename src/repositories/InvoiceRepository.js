import { createAdminClient } from '../config/supabase.js'

export class InvoiceRepository {
  async reserveCae({ invoiceId, companyId, userId }) {
    const { error } = await createAdminClient().rpc('reserve_invoice_cae', {
      p_invoice_id: invoiceId,
      p_company_id: companyId,
      p_user_id: userId,
    })
    if (error) {
      if (error.code === '23505') error.status = 409
      throw error
    }
  }

  async recordCaeResult({ invoiceId, companyId, arcaResult }) {
    const { error } = await createAdminClient()
      .from('invoice_cae_requests')
      .update({ state: 'authorized', arca_result: arcaResult, updated_at: new Date().toISOString() })
      .eq('invoice_id', invoiceId)
      .eq('company_id', companyId)
    if (error) throw error
  }

  async recordCaeRequest({ invoiceId, companyId, request }) {
    const { error } = await createAdminClient()
      .from('invoice_cae_requests')
      .update({ arca_request: request, updated_at: new Date().toISOString() })
      .eq('invoice_id', invoiceId)
      .eq('company_id', companyId)
    if (error) throw error
  }

  async assertNotDuplicate({ companyId, invoiceNumber, tipoComprobante, invoiceId }) {
    let query = createAdminClient()
      .from('invoices')
      .select('id')
      .eq('company_id', companyId)
      .eq('invoice_number', invoiceNumber)
      .eq('tipo_comprobante', tipoComprobante)
    if (invoiceId) query = query.neq('id', invoiceId)
    const { data, error } = await query.maybeSingle()

    if (error) throw error
    if (data) {
      throw new Error(
        `Ya existe una ${tipoComprobante} con el número ${invoiceNumber} en esta empresa.`
      )
    }
  }

  async createIssuedInvoice({ invoice, items, userId, arcaResult }) {
    const supabaseAdmin = createAdminClient()
    const invoiceNumber =
      `${String(arcaResult.puntoDeVenta).padStart(4, '0')}-` +
      `${String(arcaResult.numeroComprobante).padStart(8, '0')}`

    await this.assertNotDuplicate({
      companyId: invoice.company_id,
      invoiceNumber,
      tipoComprobante: invoice.tipo_comprobante,
      invoiceId: invoice.id,
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

    const { data: existing, error: existingError } = await supabaseAdmin
      .from('invoices').select('id').eq('id', invoice.id)
      .eq('company_id', invoice.company_id).maybeSingle()
    if (existingError) throw existingError

    const query = existing
      ? supabaseAdmin.from('invoices').update(row).eq('id', invoice.id).eq('company_id', invoice.company_id)
      : supabaseAdmin.from('invoices').insert(row)
    const { data: newInvoice, error: invError } = await query
      .select()
      .single()

    if (invError) throw invError

    if (items?.length > 0) {
      if (existing) {
        const { error } = await supabaseAdmin.from('invoice_items').delete().eq('invoice_id', newInvoice.id)
        if (error) throw error
      }
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
        // ARCA already authorized it. Retain the invoice and its CAE even if
        // saving the items fails; retrying emission must never issue it again.
        throw itemsError
      }
    }

    return newInvoice
  }
}
