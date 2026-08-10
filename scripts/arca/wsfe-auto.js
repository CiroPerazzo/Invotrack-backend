/**
 * scripts/arca/wsfe-auto.js — Espera a que expire el TA vigente y ejecuta el
 * flujo WSFEv1 completo automáticamente (ARCA HOMOLOGACIÓN).
 *
 * Mientras WSAA responda coe.alreadyAuthenticated (hay un TA válido emitido
 * fuera de este código, cuyo token/sign no tenemos), reintenta en silencio.
 * En cuanto AFIP permite emitir un TA nuevo, getTokenAndSign lo obtiene, lo
 * guarda en la caché (.wsaa-token-cache.json) y se corren todas las consultas
 * autenticadas. No emite comprobantes.
 *
 * Uso:
 *   node scripts/arca/wsfe-auto.js
 *
 * Opcional (para pruebas):
 *   WSFE_AUTO_INTERVAL_MS=5000 WSFE_AUTO_MAX_MS=20000 node scripts/arca/wsfe-auto.js
 */
import { getTokenAndSign, WsaaAuthError } from './wsaa.js'
import {
  feDummy,
  feParamGetPtosVenta,
  feParamGetTiposCbte,
  feParamGetTiposDoc,
  feParamGetCondicionIvaReceptor,
  feParamGetTiposIva,
  feParamGetMonedas,
  feParamGetTiposTributo,
  feCompUltimoAutorizado,
} from './wsfe-client.js'

const INTERVALO_MS = Number(process.env.WSFE_AUTO_INTERVAL_MS) || 5 * 60 * 1000
const TIMEOUT_MS = Number(process.env.WSFE_AUTO_MAX_MS) || 24 * 60 * 60 * 1000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Errores de WSAA que significan "todavía hay un TA vigente": reintentar. */
function esReintentable(err) {
  if (err instanceof WsaaAuthError && err.code === 'ALREADY_AUTHENTICATED') return true
  const m = String(err?.message ?? '')
  return /alreadyAuthenticated|sin token\/sign|loginCmsReturn|network|fetch failed|ECONN|ETIMEDOUT/i.test(m)
}

async function esperarTA() {
  const inicio = Date.now()
  let intento = 0
  for (;;) {
    if (Date.now() - inicio > TIMEOUT_MS) {
      throw new Error(`Timeout: después de ${TIMEOUT_MS / 60000} min el TA aún no expiró.`)
    }
    try {
      const auth = await getTokenAndSign()
      console.log(`[OK] ${new Date().toLocaleString()} - TA ${auth.reused ? 'REUTILIZADO' : 'OBTENIDO'}. Expira: ${auth.expirationTime}`)
      return auth
    } catch (err) {
      if (!esReintentable(err)) throw err
      intento += 1
      console.log(
        `[${new Date().toLocaleTimeString()}] Intento ${intento}: el TA actual sigue vigente. ` +
        `(${err.message}) Reintento en ${INTERVALO_MS / 60000} min...`
      )
      await sleep(INTERVALO_MS)
    }
  }
}

async function correrConsultas(auth) {
  console.log('\n[2] WSFEv1 FEDummy')
  const dummy = await feDummy(null)
  console.log(`  AppServer=${dummy.AppServer} DbServer=${dummy.DbServer} AuthServer=${dummy.AuthServer}`)

  console.log('\n[3] FEParamGetPtosVenta')
  const ptosVenta = await feParamGetPtosVenta(auth)
  console.table(ptosVenta)

  console.log('\n[4] FEParamGetTiposCbte')
  console.table(await feParamGetTiposCbte(auth))

  console.log('\n[5] FEParamGetTiposDoc')
  console.table(await feParamGetTiposDoc(auth))

  console.log('\n[6] FEParamGetCondicionIvaReceptor')
  console.table(await feParamGetCondicionIvaReceptor(auth))

  console.log('\n[7] FEParamGetTiposIva')
  console.table(await feParamGetTiposIva(auth))

  console.log('\n[8] FEParamGetMonedas')
  console.table(await feParamGetMonedas(auth))

  console.log('\n[9] FEParamGetTiposTributo')
  console.table(await feParamGetTiposTributo(auth))

  if (ptosVenta.length > 0) {
    const pv = ptosVenta.find((p) => p.nro) || ptosVenta[0]
    console.log(`\n[10] FECompUltimoAutorizado (PtoVta=${pv.nro}, CbteTipo=1)  [SOLO LECTURA]`)
    const ultimo = await feCompUltimoAutorizado(auth, { ptoVta: pv.nro, cbteTipo: 1 })
    console.log(`  Último nro autorizado: ${ultimo.cbteNro}`)
  }
}

async function main() {
  console.log('=== wsfe-auto: espera y ejecución WSFEv1 (ARCA HOMOLOGACIÓN) ===')
  console.log('El TA vigente vence aprox. entre las 09:07 y 09:29 de hoy.')
  console.log('Este script reintenta solo hasta lograrlo y NO emite comprobantes.\n')

  console.log('[1] Esperando que el TA actual expire...')
  const auth = await esperarTA()

  await correrConsultas(auth)
  console.log('\nWSFEv1 HOMOLOGACIÓN: FLUJO COMPLETO OK')
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`)
  process.exitCode = 1
})
