/**
 * afipWsaa — Autenticación contra los Web Services de ARCA (ex AFIP) vía WSAA.
 *
 * Genera el LoginTicketRequest, lo firma con XML Signature (enveloped, RSA-SHA1)
 * usando SOLO WebCrypto (crypto.subtle), disponible tanto en Deno (Edge
 * Functions de Supabase) como en Node (vitest).
 *
 * Por qué la canonicalización es determinística: el XML se genera SIN whitespace
 * entre elementos, de modo que la forma canónica C14N de cada subárbol es
 * idéntica al string compacto que construimos acá. No hay nombrespaces en
 * <loginTicketRequest>, así que el digest es exactamente el elemento sin la
 * firma. Para el SignedInfo, C14N repite el xmlns="" en cada elemento hijo,
 * que es lo que produce canonicalSignedInfo().
 */

const XMLNS = 'http://www.w3.org/2000/09/xmldsig#'
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1'

const encoder = new TextEncoder()

export const WSAA_URLS = {
  testing: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
  production: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/**
 * Formatea una fecha como hora de Buenos Aires (GMT-3, sin horario de verano)
 * en el formato que espera ARCA: YYYY-MM-DDTHH:mm:ss-03:00
 * @param {Date} date
 * @returns {string}
 */
export function formatBuenosAiresTime(date) {
  const local = new Date(date.getTime() - 3 * 60 * 60 * 1000)
  return (
    `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}` +
    `T${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}-03:00`
  )
}

/**
 * Construye el LoginTicketRequest sin firmar.
 * @param {{ uniqueId: string|number, generationTime: string, expirationTime: string, service?: string }} params
 * @returns {string}
 */
export function buildLoginTicketRequest({ uniqueId, generationTime, expirationTime, service = 'wsfe' }) {
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

// ── Helpers de base64 / PEM ─────────────────────────────────────────────────

/** @param {string} b64 @returns {Uint8Array} */
export function base64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** @param {Uint8Array} bytes @returns {string} */
export function bytesToBase64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/**
 * Extrae el cuerpo base64 de un bloque PEM.
 * @param {string} pem
 * @param {string} label - 'PRIVATE KEY' | 'RSA PRIVATE KEY' | 'CERTIFICATE'
 * @returns {string}
 */
export function extractPemBody(pem, label) {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`)
  const m = pem.match(re)
  if (!m) throw new Error(`No se encontró un bloque PEM "${label}" en la clave/certificado provistos`)
  return m[1].replace(/\s+/g, '')
}

// ── Conversión PKCS#1 → PKCS#8 ──────────────────────────────────────────────

function derLength(n) {
  if (n < 128) return [n]
  if (n < 256) return [0x81, n]
  return [0x82, (n >> 8) & 0xff, n & 0xff]
}

/**
 * Convierte una clave privada RSA a DER PKCS#8 (lo que acepta
 * crypto.subtle.importKey). Si la clave ya está en PKCS#8 la devuelve tal cual;
 * si está en PKCS#1 (BEGIN RSA PRIVATE KEY) la envuelve en un contenedor PKCS#8.
 * @param {string} pem
 * @returns {Uint8Array}
 */
export function toPkcs8Der(pem) {
  if (pem.includes('BEGIN PRIVATE KEY')) {
    return base64ToBytes(extractPemBody(pem, 'PRIVATE KEY'))
  }

  const pkcs1 = base64ToBytes(extractPemBody(pem, 'RSA PRIVATE KEY'))

  // AlgorithmIdentifier: SEQUENCE { OID rsaEncryption(1.2.840.113549.1.1.1), NULL }
  const algorithm = new Uint8Array([
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ])
  const zeroVersion = new Uint8Array([0x02, 0x01, 0x00])

  // OCTET STRING con el body PKCS#1
  const octetLen = derLength(pkcs1.length)
  const octet = new Uint8Array(1 + octetLen.length + pkcs1.length)
  octet[0] = 0x04
  octet.set(octetLen, 1)
  octet.set(pkcs1, 1 + octetLen.length)

  const inner = new Uint8Array(zeroVersion.length + algorithm.length + octet.length)
  inner.set(zeroVersion, 0)
  inner.set(algorithm, zeroVersion.length)
  inner.set(octet, zeroVersion.length + algorithm.length)

  const outerLen = derLength(inner.length)
  const pkcs8 = new Uint8Array(1 + outerLen.length + inner.length)
  pkcs8[0] = 0x30
  pkcs8.set(outerLen, 1)
  pkcs8.set(inner, 1 + outerLen.length)
  return pkcs8
}

/** @param {string} pem @returns {Promise<CryptoKey>} */
export async function importRsaPrivateKey(pem) {
  return crypto.subtle.importKey(
    'pkcs8',
    toPkcs8Der(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-1' } },
    false,
    ['sign']
  )
}

// ── Firma XML (C14N determinístico) ─────────────────────────────────────────

/**
 * Forma canónica del SignedInfo con el DigestValue dado.
 * C14N 1.0 repite la declaración de namespace por defecto en cada elemento
 * del subárbol y expande los elementos vacíos como <x></x>.
 * @param {string} digestValue
 * @returns {string}
 */
export function canonicalSignedInfo(digestValue) {
  const ns = ` xmlns="${XMLNS}"`
  const el = (name, attrs, inner) => `<${name}${ns}${attrs ? ` ${attrs}` : ''}>${inner}</${name}>`

  return el('SignedInfo', '',
    el('CanonicalizationMethod', `Algorithm="${C14N}"`, '') +
    el('SignatureMethod', `Algorithm="${RSA_SHA1}"`, '') +
    el('Reference', 'URI=""',
      el('Transforms', '',
        el('Transform', `Algorithm="${ENVELOPED}"`, '') +
        el('Transform', `Algorithm="${C14N}"`, '')
      ) +
      el('DigestMethod', `Algorithm="${SHA1}"`, '') +
      el('DigestValue', '', digestValue)
    )
  )
}

/**
 * Firma un LoginTicketRequest y devuelve el documento CMT (Certificate of
 * Message of Trust) listo para enviar a WSAA.
 *
 * El digest cubre el elemento <loginTicketRequest> sin la firma (equivalente
 * a la transform enveloped-signature), y la firma cubre la forma canónica
 * del SignedInfo.
 *
 * @param {string} xml - LoginTicketRequest generado con buildLoginTicketRequest()
 * @param {{ privateKeyPem: string, certPem: string }} params
 * @returns {Promise<string>} CMT firmado
 */
export async function signLoginTicketRequest(xml, { privateKeyPem, certPem }) {
  // Elemento loginTicketRequest sin la declaración XML (la C14N no la incluye).
  const element = xml.replace(/^<\?xml[^>]*\?>/i, '').trim()

  const digestBytes = await crypto.subtle.digest('SHA-1', encoder.encode(element))
  const digestValue = bytesToBase64(new Uint8Array(digestBytes))

  const signedInfoCanonical = canonicalSignedInfo(digestValue)
  const signatureBytes = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    await importRsaPrivateKey(privateKeyPem),
    encoder.encode(signedInfoCanonical)
  )
  const signatureValue = bytesToBase64(new Uint8Array(signatureBytes))

  const certBody = certPem.includes('-----BEGIN CERTIFICATE-----')
    ? extractPemBody(certPem, 'CERTIFICATE')
    : certPem.replace(/\s+/g, '')

  const signatureXml =
    `<Signature xmlns="${XMLNS}">` +
    `<SignedInfo>` +
    `<CanonicalizationMethod Algorithm="${C14N}"/>` +
    `<SignatureMethod Algorithm="${RSA_SHA1}"/>` +
    `<Reference URI="">` +
    `<Transforms>` +
    `<Transform Algorithm="${ENVELOPED}"/>` +
    `<Transform Algorithm="${C14N}"/>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="${SHA1}"/>` +
    `<DigestValue>${digestValue}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>` +
    `<SignatureValue>${signatureValue}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${certBody}</X509Certificate></X509Data></KeyInfo>` +
    `</Signature>`

  const close = '</loginTicketRequest>'
  const idx = element.lastIndexOf(close)
  if (idx === -1) throw new Error('LoginTicketRequest mal formado: no se encontró el cierre')
  return `<?xml version="1.0" encoding="UTF-8"?>` + element.slice(0, idx) + signatureXml + close
}

// ── Llamada a WSAA ──────────────────────────────────────────────────────────

/** @param {string} cmtXml @returns {string} */
export function buildLoginCmsEnvelope(cmtXml) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">` +
    `<soap:Body><wsaa:loginCms><wsaa:in0><![CDATA[${cmtXml}]]></wsaa:in0></wsaa:loginCms></soap:Body>` +
    `</soap:Envelope>`
  )
}

/** Extrae el contenido del primer tag dado. @returns {string|null} */
export function extractTag(xml, name) {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)
  const m = xml.match(re)
  return m ? m[1].trim() : null
}

/**
 * Parsea la respuesta de loginCms y devuelve token + sign.
 * @param {string} xml
 * @returns {{ token: string, sign: string, expirationTime: string|null }}
 */
export function parseLoginCmsResponse(xml) {
  const loginReturn = extractTag(xml, 'loginReturn')
  if (!loginReturn) throw new Error('Respuesta de WSAA sin loginReturn')
  const token = extractTag(loginReturn, 'token')
  const sign = extractTag(loginReturn, 'sign')
  const expirationTime = extractTag(loginReturn, 'expirationTime')
  if (!token || !sign) throw new Error('WSAA no devolvió token/sign')
  return { token, sign, expirationTime }
}

/**
 * Llama a WSAA loginCms y devuelve token/sign.
 * @param {{ cmtXml: string, wsaaUrl: string }} params
 * @returns {Promise<{ token: string, sign: string, expirationTime: string|null }>}
 */
export async function loginCms({ cmtXml, wsaaUrl }) {
  const res = await fetch(wsaaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '' },
    body: buildLoginCmsEnvelope(cmtXml),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`WSAA respondió HTTP ${res.status}: ${text.slice(0, 500)}`)
  return parseLoginCmsResponse(text)
}

/**
 * Obtiene token + sign de WSAA para un servicio, firmando un ticket nuevo.
 *
 * @param {{ privateKeyPem: string, certPem: string, wsaaUrl: string, service?: string, now?: Date }} params
 * @returns {Promise<{ token: string, sign: string, expirationTime: string|null }>}
 */
export async function getTokenAndSign({ privateKeyPem, certPem, wsaaUrl, service = 'wsfe', now = new Date() }) {
  const uniqueId = Math.floor(Date.now() * 1000 + Math.random() * 1000)
  const generationTime = formatBuenosAiresTime(new Date(now.getTime() - 60 * 1000))
  const expirationTime = formatBuenosAiresTime(new Date(now.getTime() + 12 * 60 * 60 * 1000))

  const unsigned = buildLoginTicketRequest({ uniqueId, generationTime, expirationTime, service })
  const cmt = await signLoginTicketRequest(unsigned, { privateKeyPem, certPem })
  return loginCms({ cmtXml: cmt, wsaaUrl })
}
