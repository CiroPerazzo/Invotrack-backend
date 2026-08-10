/**
 * WSAA (ARCA) - Cliente reutilizable con caché de Ticket de Acceso (TA).
 *
 * - Genera el TRA, lo firma como CMS/PKCS#7 (SHA1+RSA) y llama a loginCms
 *   del ambiente de HOMOLOGACIÓN (https://wsaahomo.afip.gov.ar).
 * - Guarda token/sign/expirationTime en una caché local (gitignoreada) y
 *   reutiliza el TA mientras siga vigente (renueva antes de 5 min de expirar).
 * - NUNCA imprime token ni sign completos.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPrivateKey } from 'node:crypto'
import * as zlib from 'node:zlib'
import forge from 'node-forge'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(MODULE_DIR, '..', '..')
const CACHE_FILE = resolve(MODULE_DIR, '.wsaa-token-cache.json')
const WSAA_HOMOLOGACION = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms'
const RENOVAR_ANTES_MS = 5 * 60 * 1000

export class WsaaAuthError extends Error {
  constructor(message, code = 'ERROR') {
    super(message)
    this.code = code
  }
}

function loadEnv() {
  const envPath = resolve(ROOT, '.env')
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath)
  }
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Falta la variable ${name} en .env`)
  return value
}

function formatBuenosAires(date) {
  const t = new Date(date.getTime() - 3 * 3600 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}-03:00`
}

function buildTra(service) {
  const now = new Date()
  const generationTime = formatBuenosAires(now)
  const expirationTime = formatBuenosAires(new Date(now.getTime() + 10 * 60 * 1000))
  const uniqueId = Math.floor(Date.now() / 1000) % 4294967296
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${generationTime}</generationTime>
    <expirationTime>${expirationTime}</expirationTime>
  </header>
  <service>${service}</service>
</loginTicketRequest>`
  return { xml, expirationTime }
}

function toPkcs1Pem(pkcs8Pem) {
  const key = createPrivateKey(pkcs8Pem)
  const der = key.export({ format: 'der', type: 'pkcs1' })
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN RSA PRIVATE KEY-----\n${b64}\n-----END RSA PRIVATE KEY-----`
}

function signTra(traXml, certPem, keyPem) {
  const certificate = forge.pki.certificateFromPem(certPem)
  const key = forge.pki.privateKeyFromPem(toPkcs1Pem(keyPem))

  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer(traXml, 'utf8')
  p7.addCertificate(certificate)
  p7.addSigner({
    key,
    certificate,
    digestAlgorithm: forge.pki.oids.sha1,
    authenticatedAttributes: [],
  })
  p7.sign()

  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes())
}

function buildSoapRequest(cmsBase64) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${cmsBase64}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`
}

/** Redacta token/sign y cualquier blob largo de la respuesta para diagnóstico. */
function redactSensitive(xml) {
  return xml
    .replace(/<(?:\w+:)?(token|sign)>[\s\S]*?<\/(?:\w+:)?\1>/gi, '<$1>[REDACTO]')
    .replace(/[A-Za-z0-9+/=]{48,}/g, '[BLOB-REDACTO]')
}

/** ¿El texto parece legible (sin bytes de control no-XML)? */
function isTextLike(str) {
  // Permite saltos de línea y tabs; rechaza bytes de control raros de binarios/UTF-16 mal decodificado.
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]{2,}/.test(str.slice(0, 4000))
}

/**
 * Descomprime el cuerpo según Content-Encoding. Si el header falta o miente
 * (o undici ya descomprimió), se detecta por magic bytes y se reintenta; si
 * falla, devuelve los bytes crudos.
 */
function decompressBytes(bytes, contentEncoding) {
  const hasMagic =
    (bytes[0] === 0x1f && bytes[1] === 0x8b) ? 'gzip'
    : (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) ? 'zstd'
    : (bytes[0] === 0x78 && (bytes[1] === 0x01 || bytes[1] === 0x9c || bytes[1] === 0xda)) ? 'deflate'
    : null
  const enc = (contentEncoding || hasMagic || '').toLowerCase()
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(bytes)
    if (enc.includes('br')) return zlib.brotliDecompressSync(bytes)
    if (enc.includes('deflate')) return zlib.inflateSync(bytes)
    if (hasMagic === 'zstd' && typeof zlib.decompressZstdSync === 'function') {
      return zlib.decompressZstdSync(bytes)
    }
  } catch {
    // Si el header mentía o undici ya descomprimió, seguimos con bytes crudos.
  }
  return Buffer.from(bytes)
}

/** Decodifica bytes XML respetando BOM UTF-16/UTF-8 y patrones UTF-16 sin BOM. */
function decodeXmlBytes(bytes) {
  const b = Buffer.from(bytes)
  if (b.length >= 2) {
    if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b)
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b)
    if (b[0] === 0x3c && b[1] === 0x00) return new TextDecoder('utf-16le').decode(b)
    if (b[0] === 0x00 && b[1] === 0x3c) return new TextDecoder('utf-16be').decode(b)
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8')
  }
  return b.toString('utf8')
}

/** Extrae faultcode/faultstring de un SOAP Fault de forma legible (sin prefijos de namespace). */
function extractFaultInfo(xml) {
  const faultcode = /<faultcode[^>]*>([\s\S]*?)<\/faultcode>/i.exec(xml)
  const faultstring = /<faultstring>([\s\S]*?)<\/faultstring>/i.exec(xml)
  if (!faultcode && !faultstring) return null
  const clean = (s) =>
    (s ?? '')
      .replace(/^\s*\w+:/, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim()
  return { code: clean(faultcode?.[1]), string: clean(faultstring?.[1]) }
}

function alreadyAuthenticatedMessage(fault) {
  const detalle = fault ? ` [SOAP Fault: ${fault.code} - "${fault.string}"]` : ''
  return `Ya existe un TA válido para wsfe y no tenemos su token/sign guardado.${detalle}`
}

// Devuelve { token, sign, cuit, generationTime, expirationTime } sin imprimir nada sensible.
async function loginCms(cmsBase64) {
  const response = await fetch(WSAA_HOMOLOGACION, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=UTF-8',
      SOAPAction: 'urn:LoginCms',
    },
    body: buildSoapRequest(cmsBase64),
  })

  const contentEncoding = response.headers.get('content-encoding') || ''
  const rawBytes = Buffer.from(await response.arrayBuffer())
  const bodyBytes = decompressBytes(rawBytes, contentEncoding)
  const soapText = decodeXmlBytes(bodyBytes)

  // El código de fault de AFIP suele venir como ns1:coe.alreadyAuthenticated.
  // Lo detectamos en TODO el texto SOAP para no depender del elemento exacto.
  if (/alreadyAuthenticated/i.test(soapText)) {
    throw new WsaaAuthError(alreadyAuthenticatedMessage(extractFaultInfo(soapText)), 'ALREADY_AUTHENTICATED')
  }

  const fault = extractFaultInfo(soapText)
  if (fault) {
    throw new WsaaAuthError(`WSAA SOAP Fault: code="${fault.code}", string="${fault.string}"`)
  }

  const match = /<loginCmsReturn>([\s\S]*?)<\/loginCmsReturn>/i.exec(soapText)
  if (!match) {
    throw new WsaaAuthError(`No se encontró loginCmsReturn (HTTP ${response.status})`)
  }

  const innerBytes = decompressBytes(Buffer.from(match[1].trim(), 'base64'), '')
  const loginTicketResponse = decodeXmlBytes(innerBytes)

  if (/alreadyAuthenticated/i.test(loginTicketResponse)) {
    throw new WsaaAuthError(alreadyAuthenticatedMessage(extractFaultInfo(loginTicketResponse)), 'ALREADY_AUTHENTICATED')
  }

  const token = /<(?:\w+:)?token>([\s\S]*?)<\/(?:\w+:)?token>/i.exec(loginTicketResponse)
  const sign = /<(?:\w+:)?sign>([\s\S]*?)<\/(?:\w+:)?sign>/i.exec(loginTicketResponse)
  if (!token || !sign) {
    const innerCode = /<(?:\w+:)?code>([\s\S]*?)<\/(?:\w+:)?code>/i.exec(loginTicketResponse)
    const innerString = /<(?:\w+:)?string>([\s\S]*?)<\/(?:\w+:)?string>/i.exec(loginTicketResponse)
    if (innerCode || innerString) {
      throw new WsaaAuthError(`Autenticación rechazada (${innerCode?.[1]?.trim() ?? '?'}): ${innerString?.[1]?.trim() ?? '?'}`)
    }
    if (isTextLike(loginTicketResponse)) {
      console.error('DEBUG WSAA: respuesta interna sin token/sign (redactada):\n' + redactSensitive(loginTicketResponse))
    } else {
      const raw = innerBytes
      console.error(`DEBUG WSAA: payload interno sin token/sign NO es texto UTF-8 (${raw.length} bytes).`)
      console.error(`  hex(head): ${raw.subarray(0, 40).toString('hex')}`)
      for (const [name, fn] of [
        ['gzip', zlib.gunzipSync],
        ['deflate', zlib.inflateSync],
        ['brotli', zlib.brotliDecompressSync],
      ]) {
        try {
          const out = fn(raw)
          const dec = decodeXmlBytes(out)
          console.error(`  ${name}: OK -> ${out.length} bytes | texto? ${isTextLike(dec)} | ${redactSensitive(dec).slice(0, 300)}`)
        } catch {
          console.error(`  ${name}: no aplica`)
        }
      }
    }
    throw new WsaaAuthError('Respuesta del WSAA sin token/sign')
  }

  const generation = /<generationTime>([\s\S]*?)<\/generationTime>/i.exec(loginTicketResponse)
  const expiration = /<expirationTime>([\s\S]*?)<\/expirationTime>/i.exec(loginTicketResponse)

  return {
    token: token[1].trim(),
    sign: sign[1].trim(),
    cuit: process.env.AFIP_CUIT,
    generationTime: generation?.[1]?.trim() ?? null,
    expirationTime: expiration?.[1]?.trim() ?? null,
  }
}

function readCache() {
  if (!existsSync(CACHE_FILE)) return null
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeCache(data) {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2))
  } catch (err) {
    console.warn(`No se pudo escribir la caché del TA: ${err.message}`)
  }
}

function isTokenValid(expirationTime) {
  if (!expirationTime) return false
  const exp = new Date(expirationTime).getTime()
  return Number.isFinite(exp) && exp > Date.now() + RENOVAR_ANTES_MS
}

/**
 * Devuelve { token, sign, cuit, expirationTime, reused } para el servicio indicado.
 * Reutiliza la caché si el TA sigue vigente; si no, pide uno nuevo a WSAA y lo guarda.
 * NUNCA imprime token ni sign.
 */
export async function getTokenAndSign({ service = 'wsfe' } = {}) {
  loadEnv()
  const cuit = requireEnv('AFIP_CUIT')
  const certPem = readFileSync(resolve(ROOT, requireEnv('AFIP_CERT_PATH')), 'utf8')
  const keyPem = readFileSync(resolve(ROOT, requireEnv('AFIP_KEY_PATH')), 'utf8')

  const cached = readCache()
  if (
    cached && cached.service === service && cached.cuit === cuit &&
    cached.token && cached.sign && isTokenValid(cached.expirationTime)
  ) {
    return { token: cached.token, sign: cached.sign, cuit, expirationTime: cached.expirationTime, reused: true }
  }

  const tra = buildTra(service)
  const cmsBase64 = signTra(tra.xml, certPem, keyPem)
  const auth = await loginCms(cmsBase64)

  writeCache({
    service,
    cuit,
    token: auth.token,
    sign: auth.sign,
    generationTime: auth.generationTime,
    expirationTime: auth.expirationTime,
  })

  return { token: auth.token, sign: auth.sign, cuit, expirationTime: auth.expirationTime, reused: false }
}

/** Información de la caché sin exponer token/sign (para reportes). */
export function getCachedTokenInfo({ service = 'wsfe' } = {}) {
  loadEnv()
  const cuit = process.env.AFIP_CUIT
  const cached = readCache()
  if (!cached) return { hasCache: false, valid: false, expirationTime: null, cuit }
  const valid =
    cached.service === service && cached.cuit === cuit &&
    cached.token && cached.sign && isTokenValid(cached.expirationTime)
  return { hasCache: true, valid, expirationTime: cached.expirationTime || null, cuit }
}
