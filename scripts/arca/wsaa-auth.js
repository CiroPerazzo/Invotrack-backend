/**
 * WSAA (ARCA) - Autenticación de HOMOLOGACIÓN para WSFEv1.
 *
 * Flujo (especificación técnica WSAA 1.2.2 de ARCA):
 *  1. Generar el TRA (LoginTicketRequest.xml)
 *  2. Firmarlo en CMS/PKCS#7 (SHA1+RSA) con el certificado X.509 y la clave privada
 *  3. Codificar el CMS en Base64
 *  4. Llamar a loginCms del WSAA de homologación
 *  5. Mostrar SOLO el resultado y la fecha de vencimiento del ticket (nunca token/sign)
 *
 * Uso: node scripts/arca/wsaa-auth.js
 * Requiere .env con AFIP_CUIT, AFIP_CERT_PATH y AFIP_KEY_PATH.
 * La clave privada se lee de disco pero jamás se imprime ni se registra.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createPrivateKey } from 'node:crypto'
import forge from 'node-forge'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const WSAA_HOMOLOGACION = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms'

function loadEnv() {
  const envPath = resolve(ROOT, '.env')
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath)
  } else {
    console.warn('No se encontró .env; se usan variables de entorno ya definidas.')
  }
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Falta la variable ${name} en .env`)
  return value
}

// Fecha en Buenos Aires (UTC-3, sin horario de verano) con formato ARCA: YYYY-MM-DDTHH:mm:ss-03:00
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
  const uniqueId = Math.floor(Date.now() / 1000) % 4294967296 // entero 32 bits sin signo
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

// La clave puede estar en PKCS#8 (-----BEGIN PRIVATE KEY-----); node-forge espera PKCS#1.
function toPkcs1Pem(pkcs8Pem) {
  const key = createPrivateKey(pkcs8Pem)
  const der = key.export({ format: 'der', type: 'pkcs1' })
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN RSA PRIVATE KEY-----\n${b64}\n-----END RSA PRIVATE KEY-----`
}

// Genera el CMS/PKCS#7 SignedData con el TRA como eContent, firmado con SHA1+RSA.
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

async function loginCms(cmsBase64) {
  const response = await fetch(WSAA_HOMOLOGACION, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=UTF-8',
      SOAPAction: 'urn:LoginCms',
    },
    body: buildSoapRequest(cmsBase64),
  })
  const soapText = await response.text()

  if (process.env.WSAA_DEBUG) {
    writeFileSync(resolve(tmpdir(), 'invotrack-wsaa-soap.xml'), soapText)
  }

  // Fallo SOAP directo (los distintos backends de WSAA serializan el error de formas diferentes)
  const faultstring = /<faultstring>([\s\S]*?)<\/faultstring>/i.exec(soapText)
  const faultcode = /<faultcode[^>]*>([\s\S]*?)<\/faultcode>/i.exec(soapText)
  const soapAlreadyAuthenticated =
    (faultstring && /alreadyAuthenticated/i.test(faultstring[1])) ||
    (faultcode && /alreadyAuthenticated/i.test(faultcode[1]))

  if (soapAlreadyAuthenticated) {
    return { alreadyAuthenticated: true, expirationTime: null }
  }
  if (faultstring) throw new Error(`WSAA devolvió un fault: ${faultstring[1].trim()}`)

  // Respuesta con loginCmsReturn (Base64 con el LoginTicketResponse.xml)
  const match = /<loginCmsReturn>([\s\S]*?)<\/loginCmsReturn>/i.exec(soapText)
  if (!match) {
    throw new Error(`No se encontró loginCmsReturn en la respuesta (HTTP ${response.status})`)
  }

  const loginTicketResponse = Buffer.from(match[1].trim(), 'base64').toString('utf8')
  if (process.env.WSAA_DEBUG) {
    writeFileSync(resolve(tmpdir(), 'invotrack-wsaa-response.xml'), loginTicketResponse)
  }

  if (/alreadyAuthenticated/i.test(loginTicketResponse)) {
    return { alreadyAuthenticated: true, expirationTime: null }
  }

  const token = /<token>([\s\S]*?)<\/token>/i.exec(loginTicketResponse)
  if (!token) {
    const innerCode = /<(?:\w+:)?code>([\s\S]*?)<\/(?:\w+:)?code>/i.exec(loginTicketResponse)
    const innerString = /<(?:\w+:)?string>([\s\S]*?)<\/(?:\w+:)?string>/i.exec(loginTicketResponse)
    if (innerCode || innerString) {
      throw new Error(`Autenticación rechazada (${innerCode?.[1]?.trim() ?? '?'}): ${innerString?.[1]?.trim() ?? '?'}`)
    }
    throw new Error('Respuesta del WSAA sin <token>')
  }

  const expiration = /<expirationTime>([\s\S]*?)<\/expirationTime>/i.exec(loginTicketResponse)
  return { alreadyAuthenticated: false, expirationTime: expiration ? expiration[1].trim() : 'desconocido' }
}

async function main() {
  loadEnv()

  const environment = process.env.AFIP_ENVIRONMENT || 'testing'
  if (environment !== 'testing') {
    throw new Error('Este script es SOLO para homologación (AFIP_ENVIRONMENT=testing).')
  }

  const cuit = requireEnv('AFIP_CUIT')
  if (!/^\d{11}$/.test(cuit)) throw new Error(`AFIP_CUIT inválido: ${cuit}`)

  const certPath = resolve(ROOT, requireEnv('AFIP_CERT_PATH'))
  const keyPath = resolve(ROOT, requireEnv('AFIP_KEY_PATH'))
  if (!existsSync(certPath)) throw new Error(`No existe el certificado: ${certPath}`)
  if (!existsSync(keyPath)) throw new Error(`No existe la clave privada: ${keyPath}`)

  const certPem = readFileSync(certPath, 'utf8')
  const keyPem = readFileSync(keyPath, 'utf8') // se lee de disco, jamás se imprime

  const service = 'wsfe'
  const tra = buildTra(service)
  const cmsBase64 = signTra(tra.xml, certPem, keyPem)

  const { alreadyAuthenticated, expirationTime } = await loginCms(cmsBase64)

  console.log('WSAA HOMOLOGACIÓN: AUTENTICACIÓN CORRECTA')
  if (alreadyAuthenticated) {
    console.log('Ya existe un TA activo para el servicio wsfe; WSAA no emite otro hasta que expire. ' +
      'Re-ejecutá este script más tarde para ver la fecha de vencimiento del ticket.')
  } else {
    console.log(`Ticket de ${service} válido hasta: ${expirationTime}`)
  }
}

main().catch((err) => {
  console.error(`WSAA HOMOLOGACIÓN: ERROR - ${err.message}`)
  process.exitCode = 1
})
