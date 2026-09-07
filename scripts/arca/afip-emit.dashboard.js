/**
 * afip-emit (self-contained) — receta para pegar en el Edge Functions editor
 * del Dashboard de Supabase (nombre de función: afip-emit).
 *
 * Secretos que usa (Settings → Edge Functions → Secrets):
 *   Arca.crt  → certificado X.509 de ARCA (PEM o base64)
 *   Arca.key  → clave privada RSA (PEM o base64)
 *   Arca.CUIT → CUIT de 11 dígitos (opcional: si no existe se extrae del cert)
 *   AFIP_ENVIRONMENT → 'testing' (default) | 'production'
 *
 * SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY las inyecta Supabase solo.
 *
 * Autenticación WSAA: firma el LoginTicketRequest y lo envuelve en un CMS
 * PKCS#7/SignedData (lo que ARCA exige en in0) usando node-forge. El cert/key
 * PEM se leen de los secretos. Sin archivos compartidos: este archivo es
 * autocontenido y solo importa node-forge desde npm.
 *
 * Request JSON: { action: 'cae'|'dummy'|'ptosVenta'|'diagnose', invoice? }
 */

import forge from 'npm:node-forge@1.3.1'
const { pki, pkcs7, asn1, util, md } = forge

const WSAA_URLS = {
  testing: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
  production: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
}

const WSFEv1_URLS = {
  testing: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  production: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
}

const CBTE_TIPO_MAP = {
  'Factura A': 1, 'Factura B': 6, 'Factura C': 11, 'Factura M': 20, 'Factura E': 17,
  'Nota de Crédito A': 3, 'Nota de Crédito B': 8, 'Nota de Crédito C': 13, 'Nota de Crédito M': 22, 'Nota de Crédito E': 19,
  'Nota de Débito A': 2, 'Nota de Débito B': 7, 'Nota de Débito C': 12, 'Nota de Débito M': 21, 'Nota de Débito E': 18,
  'Recibo A': 4, 'Recibo B': 9, 'Recibo C': 15, 'Recibo': 15,
}

const MONEDA_MAP = { ARS: 'PES', USD: 'USD', EUR: 'EUR', BRL: 'BRL' }
const IVA_ID_MAP = { 0: 3, 2.5: 9, 5: 8, 10.5: 4, 21: 5, 27: 6 }

// ───────────────────────────── WSAA helpers ────────────────────────────────

function pad2(n) {
  return String(n).padStart(2, '0')
}

function formatBuenosAiresTime(date) {
  // ARCA exige el formato XML Schema dateTime: 2018-01-29T13:52:57.467-03:00
  // (con milisegundos y offset -03:00, sin horario de verano).
  const local = new Date(date.getTime() - 3 * 60 * 60 * 1000)
  const ms = String(local.getUTCMilliseconds()).padStart(3, '0')
  return (
    `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}` +
    `T${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}.${ms}-03:00`
  )
}

function buildLoginTicketRequest({ uniqueId, generationTime, expirationTime, service = 'wsfe' }) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<loginTicketRequest version="1.0">` +
    `<header><uniqueId>${uniqueId}</uniqueId>` +
    `<generationTime>${generationTime}</generationTime>` +
    `<expirationTime>${expirationTime}</expirationTime></header>` +
    `<service>${service}</service>` +
    `</loginTicketRequest>`
  )
}

function extractPemBody(pem, label) {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`)
  const m = pem.match(re)
  if (!m) throw new Error(`No se encontró un bloque PEM "${label}" en la clave/certificado provistos`)
  return m[1].replace(/\s+/g, '')
}

/**
 * Construye el CMS PKCS#7 (SignedData) que ARCA espera en in0 de loginCms:
 * contiene el TRA firmado con SHA1+RSA, los atributos autenticados estándar
 * (contentType, messageDigest, signingTime) y el certificado del firmante.
 *
 * El DigestAlgorithm debe ser SHA1 (lo que soporta WSAA).
 * @returns {string} base64 del DER CMS
 */
function signTraAsCms(traXml, { certPem, keyPem }) {
  const cert = pki.certificateFromPem(certPem)
  const key = pki.privateKeyFromPem(keyPem)

  const cms = pkcs7.createSignedData()
  cms.content = util.createBuffer(traXml)
  cms.addCertificate(cert)
  cms.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: pki.oids.sha1,
    authenticatedAttributes: [
      { type: pki.oids.contentType, value: pki.oids.data },
      { type: pki.oids.messageDigest },
      { type: pki.oids.signingTime },
    ],
  })
  cms.sign()

  const der = asn1.toDer(cms.toAsn1()).getBytes()
  return util.encode64(der)
}

async function loginCms({ cmsBase64, wsaaUrl }) {
  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">` +
    `<soap:Body><wsaa:loginCms><wsaa:in0>${cmsBase64}</wsaa:in0></wsaa:loginCms></soap:Body>` +
    `</soap:Envelope>`

  const res = await fetch(wsaaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
    body: envelope,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`WSAA respondió HTTP ${res.status}: ${text.slice(0, 500)}`)
  return parseLoginCmsResponse(text)
}

function extractTag(xml, name) {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)
  const m = xml.match(re)
  return m ? m[1].trim() : null
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
}

function parseLoginCmsResponse(xml) {
  // El SOAP devuelve <loginCmsReturn> con el loginTicketResponse embebido como
  // texto con entidades XML escapadas (&lt;token&gt; etc.). Lo decodificamos
  // antes de extraer los campos.
  const loginReturn = extractTag(xml, 'loginCmsReturn') || extractTag(xml, 'loginReturn')
  if (!loginReturn) {
    throw new Error(`Respuesta de WSAA sin loginReturn. XML crudo: ${String(xml).slice(0, 1200)}`)
  }
  const ta = decodeXmlEntities(loginReturn)
  const token = extractTag(ta, 'token')
  const sign = extractTag(ta, 'sign')
  const expirationTime = extractTag(ta, 'expirationTime')
  if (!token || !sign) throw new Error('WSAA no devolvió token/sign')
  return { token, sign, expirationTime }
}

async function getTokenAndSign({ certPem, keyPem, wsaaUrl, service = 'wsfe', now = new Date() }) {
  const uniqueId = Math.floor(Date.now() / 1000)
  const generationTime = formatBuenosAiresTime(new Date(now.getTime() - 60 * 1000))
  const expirationTime = formatBuenosAiresTime(new Date(now.getTime() + 12 * 60 * 60 * 1000))
  const unsigned = buildLoginTicketRequest({ uniqueId, generationTime, expirationTime, service })
  const cmsBase64 = signTraAsCms(unsigned, { certPem, keyPem })
  return loginCms({ cmsBase64, wsaaUrl })
}

function isTokenValid(expirationTime, marginMs = 5 * 60 * 1000) {
  if (!expirationTime) return false
  const exp = new Date(expirationTime).getTime()
  return Number.isFinite(exp) && exp > Date.now() + marginMs
}

function parseCuitFromCert(certPem) {
  if (!certPem) return null
  const text = String(certPem)
  const patterns = [
    /CN\s*=\s*cuit[:\s]*(\d{11})/i,
    /CN\s*=\s*(\d{11})(?:[,]|$)/i,
    /serialNumber\s*=\s*CUIT\s+(\d{11})/i,
    /serialNumber\s*=\s*(\d{11})/i,
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m) return m[1]
  }
  return null
}

async function getTokenAndSignCached({ certPem, keyPem, wsaaUrl, service = 'wsfe', cuit, store, requestToken = getTokenAndSign }) {
  if (!store?.loadToken || !store?.saveToken) {
    throw new Error('getTokenAndSignCached requiere un store con loadToken() y saveToken()')
  }
  if (!cuit) throw new Error('getTokenAndSignCached requiere cuit para identificar el TA')

  const cached = await store.loadToken({ service, cuit })
  if (cached && isTokenValid(cached.expirationTime)) {
    return { ...cached, reused: true }
  }
  try {
    const fresh = await requestToken({ certPem, keyPem, wsaaUrl, service })
    await store.saveToken({ service, cuit, ...fresh })
    return { ...fresh, reused: false }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    const again = await store.loadToken({ service, cuit })
    if (/alreadyAuthenticated|autenticaci/i.test(m) && again && isTokenValid(again.expirationTime)) {
      return { ...again, reused: true }
    }
    throw err
  }
}

// ───────────────────────────── WSFEv1 helpers ──────────────────────────────

function numeroAfip(n) {
  return (Number(n) || 0).toFixed(2)
}

function fechaEmisionToAfip(dateStr) {
  const s = String(dateStr ?? '')
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return s.replace(/\D/g, '').slice(0, 8)
  return `${m[1]}${m[2]}${m[3]}`
}

function afipDateToIso(afipDate) {
  const s = String(afipDate ?? '')
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s
}

function getCbteTipo(tipoComprobante) {
  const codigo = CBTE_TIPO_MAP[tipoComprobante]
  if (!codigo) {
    throw new Error(`El tipo de comprobante "${tipoComprobante}" no se puede emitir con CAE`)
  }
  return codigo
}

function computeIvaFromItems(items = []) {
  const bases = { 10.5: 0, 21: 0, 27: 0 }
  for (const item of items) {
    const alicuota = Number(item.alicuota_iva ?? item.iva_rate ?? 0)
    if (!(alicuota in bases)) continue
    const base = Number(item.cantidad ?? item.quantity ?? 0) * Number(item.precio_unitario ?? item.unit_price ?? 0)
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

function mapInvoiceToCaeRequest({ invoice, cbteTipo }) {
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
  const impIVA = (Number(invoice.iva_105) || 0) + (Number(invoice.iva_21) || 0) + (Number(invoice.iva_27) || 0)
  const impTotal = Number(invoice.total_amount) > 0
    ? Number(invoice.total_amount)
    : impNeto + impIVA + (Number(invoice.exento) || 0) + (Number(invoice.otros_tributos) || 0)
  const numero = Number(invoice.numero_comprobante) || 1
  const cabecera = { ptoVta: Number(invoice.punto_de_venta) || 1, cbteTipo, cantReg: 1 }
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

function buildAuth({ token, sign, cuit }) {
  return `<Auth><Token>${token}</Token><Sign>${sign}</Sign><Cuit>${cuit}</Cuit></Auth>`
}

function soapEnvelope(operation, inner) {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xmlns:xsd="http://www.w3.org/2001/XMLSchema">` +
    `<soap:Body><${operation} xmlns="http://ar.gov.afip.dif.FEV1/">${inner}</${operation}></soap:Body>` +
    `</soap:Envelope>`
  )
}

function buildDetalle(d) {
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

function buildFeCAEReq({ cabecera, detalle }) {
  const { cantReg = 1, ptoVta, cbteTipo } = cabecera
  return (
    `<FeCAEReq>` +
    `<FeCabReq><CantReg>${cantReg}</CantReg><PtoVta>${ptoVta}</PtoVta>` +
    `<CbteTipo>${cbteTipo}</CbteTipo></FeCabReq>` +
    `<FeDetReq>${detalle.map(buildDetalle).join('')}</FeDetReq>` +
    `</FeCAEReq>`
  )
}

function extractBlocks(xml, name) {
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

function parseCaeResponse(xml) {
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

function soapHeaders(operation) {
  return {
    'Content-Type': 'text/xml; charset=utf-8',
    'SOAPAction': `http://ar.gov.afip.dif.FEV1/${operation}`,
  }
}

async function feDummy({ wsfeUrl }) {
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

async function feParamGetPtosVenta({ wsfeUrl, token, sign, cuit }) {
  const body = soapEnvelope('FEParamGetPtosVenta', buildAuth({ token, sign, cuit }))
  const res = await fetch(wsfeUrl, { method: 'POST', headers: soapHeaders('FEParamGetPtosVenta'), body })
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

function parseFeCompUltimoAutorizado(xml) {
  const errores = extractErrores(xml)
  if (errores.length > 0) return { cbteNro: null, errores }
  const n = Number(extractTag(xml, 'CbteNro'))
  return { cbteNro: Number.isFinite(n) ? n : null, errores: [] }
}

async function feCompUltimoAutorizado({ wsfeUrl, token, sign, cuit, ptoVta, cbteTipo }) {
  const body = soapEnvelope(
    'FECompUltimoAutorizado',
    buildAuth({ token, sign, cuit }) + `<PtoVta>${ptoVta}</PtoVta><CbteTipo>${cbteTipo}</CbteTipo>`
  )
  const res = await fetch(wsfeUrl, { method: 'POST', headers: soapHeaders('FECompUltimoAutorizado'), body })
  const text = await res.text()
  if (!res.ok) throw new Error(`WSFEv1 respondió HTTP ${res.status}: ${text.slice(0, 500)}`)
  return parseFeCompUltimoAutorizado(text)
}

async function fecaeSolicitar({ wsfeUrl, token, sign, cuit, cabecera, detalle }) {
  const body = soapEnvelope('FECAESolicitar', buildAuth({ token, sign, cuit }) + buildFeCAEReq({ cabecera, detalle }))
  const res = await fetch(wsfeUrl, { method: 'POST', headers: soapHeaders('FECAESolicitar'), body })
  const text = await res.text()
  if (!res.ok) throw new Error(`WSFEv1 respondió HTTP ${res.status}: ${text.slice(0, 500)}`)
  return parseCaeResponse(text)
}

// ─────────────────────────────── Config ↓ secrets ──────────────────────────

function readPemEnv(value) {
  if (!value) return null
  return value.includes('-----BEGIN') ? value : atob(value.replace(/\s+/g, ''))
}

function loadAfipConfig() {
  const secrets = {
    crt: Boolean(Deno.env.get('Arca.crt') ?? Deno.env.get('AFIP_CERT')),
    key: Boolean(Deno.env.get('Arca.key') ?? Deno.env.get('AFIP_KEY')),
    cuit: Boolean(Deno.env.get('Arca.CUIT') ?? Deno.env.get('AFIP_CUIT')),
  }
  const cert = readPemEnv(Deno.env.get('Arca.crt') ?? Deno.env.get('AFIP_CERT'))
  const key = readPemEnv(Deno.env.get('Arca.key') ?? Deno.env.get('AFIP_KEY'))
  const cuit = (Deno.env.get('Arca.CUIT') ?? Deno.env.get('AFIP_CUIT') ?? '').replace(/\D/g, '') ||
    parseCuitFromCert(cert)
  const environment = Deno.env.get('AFIP_ENVIRONMENT') ?? 'testing'
  if (!cert || !key || !cuit) {
    return { cert: null, key: null, cuit: null, environment, secrets }
  }
  return { cert, key, cuit: String(cuit).replace(/\D/g, ''), environment, secrets }
}

// ────────────────────── Store de TA (arca_tokens vía fetch) ────────────────

function createTokenStore() {
  const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return null

  const headers = (extra = {}) => ({
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    ...extra,
  })

  return {
    async loadToken({ service, cuit }) {
      const q = `select=token,sign,generation_time,expiration_time&service=eq.${encodeURIComponent(service)}&cuit=eq.${encodeURIComponent(String(cuit))}`
      const res = await fetch(`${supabaseUrl}/rest/v1/arca_tokens?${q}`, {
        headers: headers({ Accept: 'application/json' }),
      })
      if (!res.ok) return null
      const rows = await res.json()
      if (!Array.isArray(rows) || rows.length === 0) return null
      const data = rows[0]
      return {
        token: data.token,
        sign: data.sign,
        generationTime: data.generation_time,
        expirationTime: data.expiration_time,
      }
    },

    async saveToken({ service, cuit, token, sign, generationTime, expirationTime }) {
      const res = await fetch(`${supabaseUrl}/rest/v1/arca_tokens?on_conflict=service,cuit`, {
        method: 'POST',
        headers: headers({
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        }),
        body: JSON.stringify({
          service,
          cuit: String(cuit),
          token,
          sign,
          generation_time: generationTime,
          expiration_time: expirationTime,
        }),
      })
      if (!res.ok) {
        const text = await res.text()
        console.error('arca_tokens saveToken:', res.status, text.slice(0, 300))
      }
    },
  }
}

// ──────────────────────────────── Handler ──────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  try {
    let body
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Body inválido. Se esperaba JSON con action e invoice.' }, 400)
    }

    const action = body.action ?? 'cae'

    if (action === 'diagnose') {
      const cfg = loadAfipConfig()
      return json({
        ok: true,
        secrets: cfg.secrets,
        cuit: cfg.cuit ?? null,
        cuitSource: cfg.cuit ? (cfg.secrets.cuit ? 'Arca.CUIT' : 'certificado') : null,
        environment: cfg.environment,
        completo: Boolean(cfg.cert && cfg.key && cfg.cuit),
      })
    }

    const cfg = loadAfipConfig()
    if (!cfg.cert || !cfg.key || !cfg.cuit) {
      throw Object.assign(new Error(
        'Credenciales ARCA no configuradas. Revisá los secretos Arca.crt, Arca.key y Arca.CUIT (action=diagnose para detalle).'
      ), { status: 503 })
    }
    const { cert, key, cuit, environment } = cfg
    const wsaaUrl = WSAA_URLS[environment] ?? WSAA_URLS.testing
    const wsfeUrl = WSFEv1_URLS[environment] ?? WSFEv1_URLS.testing

    const { token, sign } = await getTokenAndSignCached({
      certPem: cert,
      keyPem: key,
      wsaaUrl,
      cuit,
      store: createTokenStore(),
    })

    if (action === 'dummy') {
      const status = await feDummy({ wsfeUrl })
      return json({ ok: status.appServer === 'OK', status })
    }

    if (action === 'ptosVenta') {
      const result = await feParamGetPtosVenta({ wsfeUrl, token, sign, cuit })
      return json({ ok: result.errores.length === 0, ...result })
    }

    const invoice = body.invoice
    if (!invoice) {
      return json({ error: 'invoice es requerido para la acción "cae"' }, 400)
    }

    const cbteTipo = getCbteTipo(invoice.tipo_comprobante)
    const ptoVta = Number(invoice.punto_de_venta) || 1
    let numeroComprobante = Number(invoice.numero_comprobante) || 0
    if (numeroComprobante <= 0) {
      const ultimo = await feCompUltimoAutorizado({ wsfeUrl, token, sign, cuit, ptoVta, cbteTipo })
      if (ultimo.errores.length > 0) {
        const msg = ultimo.errores.map((e) => `[${e.code}] ${e.msg}`).join(' | ')
        return json({ ok: false, error: `FECompUltimoAutorizado: ${msg}` }, 422)
      }
      numeroComprobante = (ultimo.cbteNro ?? 0) + 1
    }

    const { cabecera, detalle } = mapInvoiceToCaeRequest({
      invoice: { ...invoice, numero_comprobante: numeroComprobante },
      cbteTipo,
    })

    const result = await fecaeSolicitar({ wsfeUrl, token, sign, cuit, cabecera, detalle })
    if (result.errores.length > 0) {
      const msg = result.errores.map((e) => `[${e.code}] ${e.msg}`).join(' | ')
      return json({ ok: false, ...result, error: msg }, 422)
    }

    console.log(`afip-emit: ${invoice.tipo_comprobante} PtoVta=${cabecera.ptoVta} Nro=${detalle[0].cbteDesde} CAE=${result.cae} Resultado=${result.resultado}`)
    return json({ ok: result.ok, ...result })
  } catch (err) {
    const status = err.status ?? 500
    const message = err instanceof Error ? err.message : 'Error interno'
    console.error('afip-emit error:', message)
    return json({ error: message, ok: false }, status)
  }
}

Deno.serve(handler)