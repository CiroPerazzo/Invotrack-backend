/**
 * afipWsfe — Cliente del Web Service de Facturación Electrónica (WSFEv1)
 * de ARCA (ex AFIP).
 *
 * Construye y envía las operaciones SOAP que necesitamos para emitir
 * comprobantes con CAE:
 *   - FECAESolicitar      → solicita el CAE
 *   - FEDummy             → verifica disponibilidad del servicio
 *   - FEParamGetPtosVenta → lista los puntos de venta del CUIT
 *
 * Solo usa APIs estándar (fetch, TextEncoder) así que corre igual en Deno
 * (Edge Functions de Supabase) y en Node (vitest).
 */

export const CBTE_TIPO_MAP = {
  'Factura A': 1,
  'Factura B': 6,
  'Factura C': 11,
  'Factura M': 20,
  'Factura E': 17,
  'Nota de Crédito A': 3,
  'Nota de Crédito B': 8,
  'Nota de Crédito C': 13,
  'Nota de Crédito M': 22,
  'Nota de Crédito E': 19,
  'Nota de Débito A': 2,
  'Nota de Débito B': 7,
  'Nota de Débito C': 12,
  'Nota de Débito M': 21,
  'Nota de Débito E': 18,
  'Recibo A': 4,
  'Recibo B': 9,
  'Recibo C': 15,
  'Recibo': 15,
}

/** Códigos de moneda que espera AFIP (MonId). */
export const MONEDA_MAP = {
  ARS: 'PES',
  USD: 'USD',
  EUR: 'EUR',
  BRL: 'BRL',
}

/** Códigos de alícuota de IVA que espera AFIP (AlicIva.Id). */
export const IVA_ID_MAP = {
  0: 3,
  2.5: 9,
  5: 8,
  10.5: 4,
  21: 5,
  27: 6,
}

export const WSFEv1_URLS = {
  testing: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  production: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
}

/** Número con punto como separador decimal y 2 decimales (lo que exige AFIP). */
export function numeroAfip(n) {
  return (Number(n) || 0).toFixed(2)
}

/** Convierte YYYY-MM-DD → YYYYMMDD (formato que usa AFIP en CbteFch). */
export function fechaEmisionToAfip(dateStr) {
  const s = String(dateStr ?? '')
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return s.replace(/\D/g, '').slice(0, 8)
  return `${m[1]}${m[2]}${m[3]}`
}

/** Convierte YYYYMMDD → YYYY-MM-DD (fechas de vencimiento de CAE). */
export function afipDateToIso(afipDate) {
  const s = String(afipDate ?? '')
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s
}

/**
 * Devuelve el código AFIP de tipo de comprobante a partir del nombre usado
 * en InvoTrack. Lanza si el tipo no se puede emitir con CAE.
 * @param {string} tipoComprobante
 * @returns {number}
 */
export function getCbteTipo(tipoComprobante) {
  const codigo = CBTE_TIPO_MAP[tipoComprobante]
  if (!codigo) {
    throw new Error(`El tipo de comprobante "${tipoComprobante}" no se puede emitir con CAE`)
  }
  return codigo
}

/**
 * Calcula las alícuotas de IVA a partir de los ítems, agrupando la base
 * imponible por alícuota (igual que calculateInvoiceTotals de la app).
 * @param {Array<{ cantidad?: number|string, precio_unitario?: number|string, alicuota_iva?: number|string }>} items
 * @returns {Array<{ id: number, baseImp: number, importe: number }>}
 */
export function computeIvaFromItems(items = []) {
  const bases = { 10.5: 0, 21: 0, 27: 0 }
  for (const item of items) {
    const alicuota = Number(item.alicuota_iva ?? item.iva_rate ?? 0)
    if (!(alicuota in bases)) continue
    const base =
      Number(item.cantidad ?? item.quantity ?? 0) *
      Number(item.precio_unitario ?? item.unit_price ?? 0)
    bases[alicuota] += base
  }
  return [10.5, 21, 27]
    .filter((rate) => bases[rate] > 0)
    .map((rate) => {
      const baseImp = Math.round((bases[rate] + Number.EPSILON) * 100) / 100
      return {
        id: IVA_ID_MAP[rate],
        baseImp,
        importe: Math.round((baseImp * rate / 100 + Number.EPSILON) * 100) / 100,
      }
    })
}

/**
 * Mapea una factura de InvoTrack al detalle FECAEDetRequest de AFIP.
 * @param {{ invoice: object, cbteTipo: number }} params
 * @returns {{ cabecera: object, detalle: object[] }}
 */
export function mapInvoiceToCaeRequest({ invoice, cbteTipo }) {
  const moneda = invoice.moneda ?? 'ARS'
  const monId = MONEDA_MAP[moneda] ?? 'PES'
  const monCotiz = moneda === 'ARS' ? 1 : Number(invoice.tipo_cambio) || 1

  const esAnonimo = invoice.consumidor_final_anonimo === true
  const receptorCuit = String(invoice.receptor_cuit ?? '').replace(/\D/g, '')
  const docNro = esAnonimo || !receptorCuit ? 0 : Number(receptorCuit)

  const cbteFch = fechaEmisionToAfip(invoice.fecha_emision)
  const iva = computeIvaFromItems(invoice.items ?? [])
  const netoItems = iva.reduce((acc, a) => acc + a.baseImp, 0)

  const impNeto = Number(invoice.neto_gravado) > 0 ? Number(invoice.neto_gravado) : netoItems
  const impIVA =
    (Number(invoice.iva_105) || 0) +
    (Number(invoice.iva_21) || 0) +
    (Number(invoice.iva_27) || 0)
  const impTotal =
    Number(invoice.total_amount) > 0
      ? Number(invoice.total_amount)
      : impNeto + impIVA + (Number(invoice.exento) || 0) + (Number(invoice.otros_tributos) || 0)

  const numero = Number(invoice.numero_comprobante) || 1

  const cabecera = {
    ptoVta: Number(invoice.punto_de_venta) || 1,
    cbteTipo,
    cantReg: 1,
  }

  const detalle = [{
    concepto: 1,
    docTipo: 80,
    docNro,
    cbteDesde: numero,
    cbteHasta: numero,
    cbteFch,
    impTotal,
    impTotConc: Number(invoice.neto_no_gravado) || 0,
    impNeto,
    impOpEx: Number(invoice.exento) || 0,
    impIVA,
    impTrib: Number(invoice.otros_tributos) || 0,
    monId,
    monCotiz,
    iva,
  }]

  return { cabecera, detalle }
}

// ── Construcción de XML SOAP ────────────────────────────────────────────────

export function buildAuth({ token, sign, cuit }) {
  return `<Auth><Token>${token}</Token><Sign>${sign}</Sign><Cuit>${cuit}</Cuit></Auth>`
}

export function soapEnvelope(operation, inner) {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xmlns:xsd="http://www.w3.org/2001/XMLSchema">` +
    `<soap:Body><${operation} xmlns="http://ar.gov.afip.dif.FEV1/">${inner}</${operation}></soap:Body>` +
    `</soap:Envelope>`
  )
}

export function buildDetalle(d) {
  const tags = [
    `<Concepto>${d.concepto ?? 1}</Concepto>`,
    `<DocTipo>${d.docTipo ?? 80}</DocTipo>`,
    `<DocNro>${d.docNro ?? 0}</DocNro>`,
    `<CbteDesde>${d.cbteDesde}</CbteDesde>`,
    `<CbteHasta>${d.cbteHasta ?? d.cbteDesde}</CbteHasta>`,
    `<CbteFch>${d.cbteFch}</CbteFch>`,
    `<ImpTotal>${numeroAfip(d.impTotal)}</ImpTotal>`,
    `<ImpTotConc>${numeroAfip(d.impTotConc ?? 0)}</ImpTotConc>`,
    `<ImpNeto>${numeroAfip(d.impNeto)}</ImpNeto>`,
    `<ImpOpEx>${numeroAfip(d.impOpEx ?? 0)}</ImpOpEx>`,
    `<ImpIVA>${numeroAfip(d.impIVA ?? 0)}</ImpIVA>`,
    `<ImpTrib>${numeroAfip(d.impTrib ?? 0)}</ImpTrib>`,
    `<MonId>${d.monId ?? 'PES'}</MonId>`,
    `<MonCotiz>${numeroAfip(d.monCotiz ?? 1)}</MonCotiz>`,
  ]

  if (d.concepto === 2 || d.concepto === 3) {
    tags.push(`<FchServDesde>${d.fchServDesde ?? d.cbteFch}</FchServDesde>`)
    tags.push(`<FchServHasta>${d.fchServHasta ?? d.cbteFch}</FchServHasta>`)
    tags.push(`<FchVtoPago>${d.fchVtoPago ?? d.cbteFch}</FchVtoPago>`)
  }

  if ((d.iva ?? []).length > 0) {
    tags.push(`<Iva>${d.iva
      .map((a) =>
        `<AlicIva><Id>${a.id}</Id><BaseImp>${numeroAfip(a.baseImp)}</BaseImp>` +
        `<Importe>${numeroAfip(a.importe)}</Importe></AlicIva>`
      )
      .join('')}</Iva>`)
  }

  return `<FECAEDetRequest>${tags.join('')}</FECAEDetRequest>`
}

export function buildFeCAEReq({ cabecera, detalle }) {
  const { cantReg = 1, ptoVta, cbteTipo } = cabecera
  return (
    `<FeCAEReq>` +
    `<FeCabReq><CantReg>${cantReg}</CantReg><PtoVta>${ptoVta}</PtoVta>` +
    `<CbteTipo>${cbteTipo}</CbteTipo></FeCabReq>` +
    `<FeDetReq>${detalle.map(buildDetalle).join('')}</FeDetReq>` +
    `</FeCAEReq>`
  )
}

// ── Parseo de respuestas ────────────────────────────────────────────────────

export function extractTag(xml, name) {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)
  const m = xml.match(re)
  return m ? m[1].trim() : null
}

export function extractBlocks(xml, name) {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g')
  const out = []
  let m
  while ((m = re.exec(xml))) out.push(m[1])
  return out
}

function extractErrores(xml) {
  return extractBlocks(xml, 'Err').map((b) => ({
    code: extractTag(b, 'Code'),
    msg: extractTag(b, 'Msg'),
  }))
}

function extractObservaciones(xml) {
  return extractBlocks(xml, 'Obs').map((b) => ({
    code: extractTag(b, 'Code'),
    msg: extractTag(b, 'Msg'),
  }))
}

/**
 * Parsea la respuesta de FECAESolicitar.
 * @param {string} xml
 * @returns {{
 *   resultado: string|null,
 *   ok: boolean,
 *   cae: string|null,
 *   caeVencimiento: string|null,
 *   errores: Array<{code,msg}>,
 *   observaciones: Array<{code,msg}>
 * }}
 */
export function parseCaeResponse(xml) {
  const resultado = extractTag(xml, 'Resultado')
  const errores = extractErrores(xml)
  const observaciones = extractObservaciones(xml)

  if (errores.length > 0) {
    return { resultado: 'R', ok: false, cae: null, caeVencimiento: null, errores, observaciones }
  }

  return {
    resultado,
    ok: resultado === 'A',
    cae: extractTag(xml, 'CAE') ?? null,
    caeVencimiento: afipDateToIso(extractTag(xml, 'CAEFchVto')),
    errores,
    observaciones,
  }
}

// ── Operaciones SOAP ────────────────────────────────────────────────────────

function soapHeaders(operation) {
  return {
    'Content-Type': 'text/xml; charset=utf-8',
    'SOAPAction': `http://ar.gov.afip.dif.FEV1/${operation}`,
  }
}

/**
 * FEDummy — verifica que el servicio esté disponible.
 * @param {{ wsfeUrl: string }} params
 * @returns {Promise<{ appServer: string|null, dbServer: string|null, authServer: string|null }>}
 */
export async function feDummy({ wsfeUrl }) {
  const res = await fetch(wsfeUrl, {
    method: 'POST',
    headers: soapHeaders('FEDummy'),
    body: soapEnvelope('FEDummy', ''),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`WSFEv1 respondió HTTP ${res.status}: ${text.slice(0, 500)}`)
  return {
    appServer: extractTag(text, 'AppServer'),
    dbServer: extractTag(text, 'DbServer'),
    authServer: extractTag(text, 'AuthServer'),
  }
}

/**
 * FEParamGetPtosVenta — lista los puntos de venta habilitados del CUIT.
 * @param {{ wsfeUrl: string, token: string, sign: string, cuit: string|number }} params
 * @returns {Promise<{ puntos: Array<{ nro: number, emisionTipo: string, bloqueado: boolean }>, errores: Array<{code,msg}> }>}
 */
export async function feParamGetPtosVenta({ wsfeUrl, token, sign, cuit }) {
  const body = soapEnvelope(
    'FEParamGetPtosVenta',
    buildAuth({ token, sign, cuit })
  )
  const res = await fetch(wsfeUrl, {
    method: 'POST',
    headers: soapHeaders('FEParamGetPtosVenta'),
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`WSFEv1 respondió HTTP ${res.status}: ${text.slice(0, 500)}`)

  const errores = extractErrores(text)
  if (errores.length > 0) return { puntos: [], errores }

  const puntos = extractBlocks(text, 'PtoVenta').map((b) => ({
    nro: Number(extractTag(b, 'Nro')) || 0,
    emisionTipo: extractTag(b, 'EmisionTipo'),
    bloqueado: extractTag(b, 'Bloqueado') === 'S',
  }))
  return { puntos, errores }
}

/**
 * FECAESolicitar — solicita el CAE para un comprobante.
 * @param {{ wsfeUrl: string, token: string, sign: string, cuit: string|number, cabecera: object, detalle: object[] }} params
 * @returns {Promise<object>} resultado de parseCaeResponse()
 */
export async function fecaeSolicitar({ wsfeUrl, token, sign, cuit, cabecera, detalle }) {
  const body = soapEnvelope(
    'FECAESolicitar',
    buildAuth({ token, sign, cuit }) + buildFeCAEReq({ cabecera, detalle })
  )
  const res = await fetch(wsfeUrl, {
    method: 'POST',
    headers: soapHeaders('FECAESolicitar'),
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`WSFEv1 respondió HTTP ${res.status}: ${text.slice(0, 500)}`)
  return parseCaeResponse(text)
}
