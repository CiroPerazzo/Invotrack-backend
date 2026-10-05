import {
  CONDICION_IVA_RECEPTOR_MAP,
  EMIT_SUPPORTED_TYPES,
  IVA_ALICUOTA_MAP,
  formatCaeVencimiento,
  getAfipCbteTipo,
  stripCuit,
  toAfipDate,
} from '../domain/tipoComprobanteMap.js'

const CONCEPTO_PRODUCTOS = 1

function buildIvaArray(items, netoGravado, iva105, iva21, iva27) {
  const fromItems = aggregateIvaFromItems(items)
  if (fromItems.length > 0) return fromItems

  const rows = []
  if (iva105 > 0) {
    rows.push({ Id: 4, BaseImp: round2(netoGravado || iva105 / 0.105), Importe: round2(iva105) })
  }
  if (iva21 > 0) {
    rows.push({ Id: 5, BaseImp: round2(netoGravado || iva21 / 0.21), Importe: round2(iva21) })
  }
  if (iva27 > 0) {
    rows.push({ Id: 6, BaseImp: round2(netoGravado || iva27 / 0.27), Importe: round2(iva27) })
  }
  if (rows.length === 0 && netoGravado > 0) {
    rows.push({ Id: 5, BaseImp: round2(netoGravado), Importe: round2(iva21) })
  }
  return rows
}

function aggregateIvaFromItems(items = []) {
  const buckets = {}

  for (const item of items) {
    const rate = Number(item.alicuota_iva ?? item.iva_rate ?? 21)
    const qty = Number(item.cantidad ?? item.quantity ?? 1)
    const price = Number(item.precio_unitario ?? item.unit_price ?? 0)
    const net = round2(qty * price)
    const ivaId = IVA_ALICUOTA_MAP[rate]
    if (ivaId == null) continue

    if (!buckets[ivaId]) buckets[ivaId] = { Id: ivaId, BaseImp: 0, Importe: 0 }
    buckets[ivaId].BaseImp += net
    buckets[ivaId].Importe += round2(net * (rate / 100))
  }

  return Object.values(buckets).map((row) => ({
    Id: row.Id,
    BaseImp: round2(row.BaseImp),
    Importe: round2(row.Importe),
  }))
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100
}

function resolveReceptor(invoice) {
  const anonimo = invoice.consumidor_final_anonimo === true
  if (anonimo) {
    return {
      DocTipo: 99,
      DocNro: 0,
      CondicionIVAReceptorId: 5,
    }
  }

  const cuit = stripCuit(invoice.receptor_cuit)
  const condicion = invoice.receptor_condicion_iva ?? 'CF'

  return {
    DocTipo: cuit ? 80 : 99,
    DocNro: cuit || 0,
    CondicionIVAReceptorId: CONDICION_IVA_RECEPTOR_MAP[condicion] ?? 5,
  }
}

/**
 * Construye el payload para afip.ElectronicBilling.createVoucher().
 */
export function mapInvoiceToVoucher(invoice, numeroComprobante) {
  const tipo = invoice.tipo_comprobante ?? 'Factura B'

  if (!EMIT_SUPPORTED_TYPES.includes(tipo)) {
    throw new Error(
      `Por ahora solo se puede emitir: ${EMIT_SUPPORTED_TYPES.join(', ')}. ` +
      `Pediste: ${tipo}.`
    )
  }

  const cbteTipo = getAfipCbteTipo(tipo)
  const puntoVenta = Number(invoice.punto_de_venta ?? 1)
  const receptor = resolveReceptor(invoice)

  const netoGravado = round2(invoice.neto_gravado ?? 0)
  const exento = round2(invoice.exento ?? 0)
  const netoNoGravado = round2(invoice.neto_no_gravado ?? 0)
  const iva105 = round2(invoice.iva_105 ?? 0)
  const iva21 = round2(invoice.iva_21 ?? 0)
  const iva27 = round2(invoice.iva_27 ?? 0)
  const tributos = round2(invoice.otros_tributos ?? 0)
  const impIva = round2(iva105 + iva21 + iva27)
  const impTotal = round2(invoice.total_amount ?? netoGravado + impIva + exento + netoNoGravado + tributos)

  const iva = buildIvaArray(invoice.items, netoGravado, iva105, iva21, iva27)

  return {
    CantReg: 1,
    PtoVta: puntoVenta,
    CbteTipo: cbteTipo,
    Concepto: CONCEPTO_PRODUCTOS,
    DocTipo: receptor.DocTipo,
    DocNro: receptor.DocNro,
    CbteDesde: numeroComprobante,
    CbteHasta: numeroComprobante,
    CbteFch: toAfipDate(invoice.fecha_emision),
    ImpTotal: impTotal,
    ImpTotConc: netoNoGravado,
    ImpNeto: netoGravado,
    ImpOpEx: exento,
    ImpIVA: impIva,
    ImpTrib: tributos,
    MonId: invoice.moneda === 'USD' ? 'DOL' : 'PES',
    MonCotiz: Number(invoice.tipo_cambio ?? 1),
    CondicionIVAReceptorId: receptor.CondicionIVAReceptorId,
    Iva: iva,
  }
}

/**
 * Emite comprobante electrónico y devuelve CAE.
 * @see https://docs.afipsdk.com/siguientes-pasos/web-services/factura-electronica/factura-b.md
 */
export class ElectronicBillingService {
  constructor(afipClientFactory = null) {
    this.getClient = afipClientFactory
  }

  async emitInvoice(invoice) {
    const afip = this.getClient()
    const puntoVenta = Number(invoice.punto_de_venta ?? 1)
    const cbteTipo = getAfipCbteTipo(invoice.tipo_comprobante ?? 'Factura B')

    const lastVoucher = await afip.ElectronicBilling.getLastVoucher(puntoVenta, cbteTipo)
    const nextNumber = lastVoucher + 1

    const voucherData = mapInvoiceToVoucher(invoice, nextNumber)
    const result = await afip.ElectronicBilling.createVoucher(voucherData)

    if (!result?.CAE) {
      const detail = result?.Errors ?? result?.Observaciones ?? result
      throw new Error(
        `ARCA no autorizó el comprobante: ${JSON.stringify(detail)}`
      )
    }

    return {
      cae: String(result.CAE),
      caeVencimiento: formatCaeVencimiento(result.CAEFchVto),
      numeroComprobante: nextNumber,
      puntoDeVenta: puntoVenta,
      afipResponse: result,
    }
  }
}
