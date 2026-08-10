/**
 * scripts/arca/cae-test.js — Primera factura de prueba contra ARCA HOMOLOGACIÓN.
 *
 * ⚠️ SOLO se ejecuta con autorización EXPRESA. NO está diseñado para producción.
 *
 * Flujo:
 *   WSAA (TA cacheado) → FEDummy → catálogos WSFE (ptos de venta, tipos de
 *   comprobante/doc, alícuotas, monedas) → validar los datos recibidos contra
 *   esos catálogos → emitirCaeIdempotente (número siguiente consultado a ARCA,
 *   nunca hardcodeado) → imprimir el registro listo para persistir.
 *
 * Idempotencia: los intentos se guardan en scripts/arca/.cae-intents.json
 * (gitignoreado). Si se corta la conexión después de que ARCA autorizó, al
 * re-ejecutar el script FECompConsultar recupera el CAE sin emitir duplicado.
 *
 * Uso (los catálogos se validan contra WSFE; nada hardcodeado):
 *   node scripts/arca/cae-test.js \
 *     --ptoVta 1 --cbteTipo 1 --docTipo 80 --docNro 20111111112 \
 *     --iva21 10000 [--concepto 1] [--moneda PES] [--cotiz 1] [--fecha YYYYMMDD]
 *
 *   Alícuotas: --iva105 <base>, --iva21 <base>, --iva27 <base> (al menos una).
 *   neto/iva/total se calculan de las bases y se validan por consistencia.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTokenAndSign } from './wsaa.js'
import {
  feDummy,
  feParamGetPtosVenta,
  feParamGetTiposCbte,
  feParamGetTiposDoc,
  feParamGetTiposIva,
  feParamGetMonedas,
  emitirCaeIdempotente,
  procesarRespuestaCae,
} from './wsfe-client.js'
import { parseArgs, camposFaltantes, validarDatosFactura } from './cae-utils.js'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const INTENTS_FILE = resolve(MODULE_DIR, '.cae-intents.json')

// ── Store de intentos en archivo (gitignoreado) ─────────────────────────────
function cargarIntento({ ptoVta, cbteTipo }) {
  if (!existsSync(INTENTS_FILE)) return null
  try {
    const data = JSON.parse(readFileSync(INTENTS_FILE, 'utf8'))
    const intento = data[`${ptoVta}:${cbteTipo}`]
    return intento?.estado === 'PENDIENTE_ARCA' ? intento : null
  } catch {
    return null
  }
}

function guardarIntento(intento) {
  let data = {}
  if (existsSync(INTENTS_FILE)) {
    try { data = JSON.parse(readFileSync(INTENTS_FILE, 'utf8')) } catch { data = {} }
  }
  data[`${intento.ptoVta}:${intento.cbteTipo}`] = intento
  writeFileSync(INTENTS_FILE, JSON.stringify(data, null, 2))
}

// ── Construcción de la factura a partir de las bases de IVA ─────────────────
function construirDatosFactura(args, fecha) {
  const alicuotas = {
    4: args.iva105,
    5: args.iva21,
    6: args.iva27,
  }
  const iva = Object.entries(alicuotas)
    .filter(([, base]) => base != null)
    .map(([id, base]) => ({
      id: Number(id),
      baseImp: Number(base),
      importe: Math.round((Number(base) * (id === '4' ? 10.5 : id === '5' ? 21 : 27) / 100 + Number.EPSILON) * 100) / 100,
    }))

  const impNeto = iva.reduce((acc, a) => acc + a.baseImp, 0)
  const impIva = iva.reduce((acc, a) => acc + a.importe, 0)

  return {
    ptoVta: args.ptoVta,
    cbteTipo: args.cbteTipo,
    concepto: args.concepto ?? 1,
    docTipo: args.docTipo,
    docNro: args.docNro,
    cbteFch: args.fecha || fecha,
    impTotal: args.impTotal ?? impNeto + impIva,
    impNeto: args.impNeto ?? impNeto,
    impIva: args.impIva ?? impIva,
    impOpEx: args.impOpEx ?? 0,
    impTotConc: args.impTotConc ?? 0,
    impTrib: args.impTrib ?? 0,
    monId: args.moneda ?? 'PES',
    monCotiz: args.cotiz ?? 1,
    iva,
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if ((process.env.AFIP_ENVIRONMENT || 'testing') !== 'testing') {
    throw new Error('cae-test.js es SOLO para ARCA HOMOLOGACIÓN (AFIP_ENVIRONMENT=testing).')
  }

  const args = parseArgs(process.argv.slice(2))

  console.log('=== InvoTrack - Primera factura de prueba (ARCA HOMOLOGACIÓN) ===\n')

  const faltantes = camposFaltantes(args)
  if (faltantes.length > 0) {
    console.error('FALTAN DATOS para construir la factura de prueba. Se necesita:')
    for (const f of faltantes) console.error(`  - ${f}`)
    console.error('\nEjemplo:')
    console.error('  node scripts/arca/cae-test.js --ptoVta 1 --cbteTipo 1 --docTipo 80 --docNro 20111111112 --iva21 10000')
    process.exitCode = 1
    return
  }
  if (args.iva105 == null && args.iva21 == null && args.iva27 == null) {
    console.error('FALTA la base imponible de IVA. Usá al menos una de: --iva105, --iva21, --iva27.')
    process.exitCode = 1
    return
  }

  console.log('[1] WSAA: obtener/reutilizar TA')
  const auth = await getTokenAndSign()
  console.log(`    TA ${auth.reused ? 'REUTILIZADO' : 'OBTENIDO'}. Expira: ${auth.expirationTime}`)

  console.log('[2] FEDummy')
  const dummy = await feDummy(null)
  console.log(`    AppServer=${dummy.AppServer} DbServer=${dummy.DbServer} AuthServer=${dummy.AuthServer}`)

  console.log('[3] Catálogos WSFE (para validar, nada hardcodeado)')
  const ptosVenta = await feParamGetPtosVenta(auth)
  const tiposCbte = await feParamGetTiposCbte(auth)
  const tiposDoc = await feParamGetTiposDoc(auth)
  const tiposIva = await feParamGetTiposIva(auth)
  const monedas = await feParamGetMonedas(auth)
  console.log(`    Puntos de venta: ${ptosVenta.map((p) => p.nro).join(', ') || '(ninguno)'}`)
  console.log(`    Tipos de comprobante disponibles para emitir con CAE: ${tiposCbte.filter((t) => t.fchHasta == null).map((t) => `${t.id}=${t.desc}`).join(' | ') || '(ninguno)'}`)

  const hoy = new Date()
  const fecha = `${hoy.getFullYear()}${String(hoy.getMonth() + 1).padStart(2, '0')}${String(hoy.getDate()).padStart(2, '0')}`
  const datosFactura = construirDatosFactura(args, fecha)

  console.log('\n[4] Validación de los datos contra ARCA')
  const validacion = validarDatosFactura(datosFactura, {
    ptosVenta, tiposCbte, tiposDoc, tiposIva, monedas,
  })
  if (!validacion.ok) {
    console.error('Datos NO válidos contra ARCA. Corregir:')
    for (const e of validacion.errores) console.error(`  - ${e}`)
    process.exitCode = 1
    return
  }
  console.log('    OK: punto de venta, tipo de comprobante, documento, moneda, alícuotas e importes coherentes.')
  console.log('    (el número de comprobante se consultará a ARCA con FECompUltimoAutorizado)')

  console.log('\n[5] Emisión idempotente (número siguiente consultado a ARCA)')
  const respuesta = await emitirCaeIdempotente(
    auth,
    datosFactura,
    { cargarIntento, guardarIntento }
  )

  const registro = procesarRespuestaCae(respuesta)
  console.log(`\nResultado: ${registro.resultado} | Estado: ${registro.estado}${respuesta.recuperado ? ' (CAE RECUPERADO por FECompConsultar, no se re-emitió)' : ''}`)
  console.log(`Comprobante: PtoVta ${registro.puntoVenta} · Tipo ${registro.tipoComprobante} · Nro ${registro.numero}`)
  if (registro.cae) console.log(`CAE: ${registro.cae} (vence ${registro.caeVencimiento})`)
  for (const o of registro.observaciones) console.log(`  Observación [${o.code}]: ${o.msg}`)
  for (const e of registro.errores) console.log(`  Error [${e.code}]: ${e.msg}`)

  console.log('\nRegistro listo para persistir:')
  console.log(JSON.stringify(registro, null, 2))

  if (registro.estado === 'AUTORIZADO' && !respuesta.recuperado) {
    console.log('\n⚠️  Comprobante EMITIDO en HOMOLOGACIÓN. No es una factura real.')
  }
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`)
  process.exitCode = 1
})
