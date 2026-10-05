/**
 * scripts/arca/generar-csr.mjs — genera clave privada (PKCS#8) y CSR para
 * obtener el certificado de ARCA WSASS (homologación) sin depender de openssl.
 *
 * Uso:
 *   node scripts/arca/generar-csr.mjs --cuit 20409378472 --alias InvoTrackTest
 *
 * Resultado en scripts/arca/salida/:
 *   clave-privada.key → NUNCA se sube ni comparte (va como certificados/invotrack.key)
 *   pedido.csr        → se pega en WSASS para obtener el certificado firmado
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import forge from 'node-forge'
import { esCuitValido } from './cae-utils.js'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = resolve(MODULE_DIR, 'salida')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (!raw.startsWith('--')) continue
    const eq = raw.indexOf('=')
    const key = eq !== -1 ? raw.slice(2, eq) : raw.slice(2)
    let value = eq !== -1 ? raw.slice(eq + 1) : argv[++i] ?? ''
    if (value.startsWith('--')) value = ''
    if (key) out[key] = value
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const cuit = String(args.cuit ?? process.env.AFIP_CUIT ?? '').replace(/\D/g, '')
  const alias = args.alias ?? 'InvoTrackTest'

  if (!/^\d{11}$/.test(cuit)) {
    console.error('Falta --cuit (11 dígitos). Ej: node scripts/arca/generar-csr.mjs --cuit 20409378472')
    process.exitCode = 1
    return
  }
  if (!esCuitValido(cuit)) {
    console.error(`El CUIT ${cuit} no pasa el dígito verificador. Revisá antes de generar el CSR.`)
    process.exitCode = 1
    return
  }

  console.log(`Generando clave RSA 2048 y CSR para CUIT ${cuit} / ${alias}...`)

  const keys = forge.pki.rsa.generateKeyPair(2048)
  const csr = forge.pki.createCertificationRequest()
  csr.publicKey = keys.publicKey
  csr.setSubject([
    { name: 'countryName', value: 'AR' },
    { name: 'organizationName', value: 'InvoTrack' },
    { name: 'commonName', value: alias },
    { name: 'serialNumber', value: `CUIT ${cuit}` },
  ])
  csr.sign(keys.privateKey, forge.md.sha256.create())

  const csrPem = forge.pki.certificationRequestToPem(csr)
  const keyPkcs1Pem = forge.pki.privateKeyToPem(keys.privateKey)

  const pkcs8Pem = (() => {
    const asn1 = forge.pki.privateKeyToAsn1(keys.privateKey)
    const { asn1: pkcs8 } = forge.pki.privateKeyToPkcs8?.(asn1) ?? {}
    return pkcs8 ? forge.pki.privateKeyToPem(pkcs8) : keyPkcs1Pem
  })()

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true })

  const keyPath = resolve(OUTPUT_DIR, 'clave-privada.key')
  const csrPath = resolve(OUTPUT_DIR, 'pedido.csr')
  writeFileSync(keyPath, pkcs8Pem)
  writeFileSync(csrPath, csrPem)

  console.log('\nListo. Archivos en:')
  console.log(`  ${keyPath}  → NUNCA la subas ni compartas`)
  console.log(`  ${csrPath}  → pegá TODO este archivo en WSASS (homologación)`)

  const verificado = forge.pki.certificationRequestFromPem(csrPem)
  const attrs = verificado.subject.attributes
  const cn = attrs.find((a) => a.type === '2.5.4.3' || a.name === 'commonName')?.value
  const serial = attrs.find((a) => a.type === '2.5.4.5' || a.name === 'serialNumber')?.value
  const ok = verificado.verify()
  console.log(`\nVerificación CSR: subject CN="${cn}", serialNumber="${serial}", firma=${ok ? 'OK' : 'FALLO'}`)
}

main()