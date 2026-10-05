/**
 * Prueba integral WSFEv1 HOMOLOGACIÓN.
 *
 * Flujo:
 *   WSAA -> obtener/reutilizar TA -> WSFEv1 -> FEDummy -> puntos de venta
 *   -> tipos de comprobante -> resultado
 *
 * Uso: node scripts/arca/wsfe-test.js
 * No emite comprobantes. No imprime token ni sign.
 */
import { getTokenAndSign, getCachedTokenInfo, WsaaAuthError } from './wsaa.js'
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

async function main() {
  console.log('=== InvoTrack - ARCA WSFEv1 HOMOLOGACIÓN ===\n')

  // 1) WSAA
  console.log('[1] WSAA: obtener/reutilizar TA (wsfe)')
  const cacheInfo = getCachedTokenInfo()
  if (cacheInfo.hasCache) {
    console.log(`  Caché de TA presente. ¿Válido para reusar? ${cacheInfo.valid ? 'sí' : 'no'}` +
      (cacheInfo.expirationTime ? ` (expira: ${cacheInfo.expirationTime})` : ''))
  } else {
    console.log('  No hay caché de TA guardado por nuestro código.')
  }

  let auth = null
  try {
    const ta = await getTokenAndSign()
    auth = ta
    console.log(`  TA ${ta.reused ? 'REUTILIZADO de la caché' : 'OBTENIDO de WSAA'}. Expira: ${ta.expirationTime}`)
  } catch (err) {
    if (err instanceof WsaaAuthError && err.code === 'ALREADY_AUTHENTICATED') {
      console.log('  AVISO: WSAA informa que ya hay un TA válido para wsfe, pero NO tenemos')
      console.log('  su token/sign guardado (fue emitido fuera de este código).')
      console.log(`  (${err.message})`)
      console.log('  La caché queda preparada: cuando WSAA emita el próximo TA, se guardará')
      console.log('  automáticamente y se reutilizará hasta que expire.')
    } else {
      console.log(`  WSAA ERROR: ${err.message}`)
    }
  }

  // 2) FEDummy (no requiere autenticación)
  console.log('\n[2] WSFEv1 FEDummy')
  try {
    const dummy = await feDummy(null)
    console.log(`  AppServer=${dummy.AppServer}  DbServer=${dummy.DbServer}  AuthServer=${dummy.AuthServer}`)
  } catch (err) {
    console.log(`  FEDummy ERROR: ${err.message}`)
  }

  // 3) Consultas de parámetros (requieren TA válido)
  if (auth) {
    console.log('\n[3] FEParamGetPtosVenta')
    const ptosVenta = await feParamGetPtosVenta(auth)
    console.table(ptosVenta)

    console.log('\n[4] FEParamGetTiposCbte')
    const tiposCbte = await feParamGetTiposCbte(auth)
    console.table(tiposCbte)

    console.log('\n[5] FEParamGetTiposDoc')
    const tiposDoc = await feParamGetTiposDoc(auth)
    console.table(tiposDoc)

    console.log('\n[6] FEParamGetCondicionIvaReceptor')
    const condIva = await feParamGetCondicionIvaReceptor(auth)
    console.table(condIva)

    console.log('\n[7] FEParamGetTiposIva')
    const tiposIva = await feParamGetTiposIva(auth)
    console.table(tiposIva)

    console.log('\n[8] FEParamGetMonedas')
    const monedas = await feParamGetMonedas(auth)
    console.table(monedas)

    console.log('\n[9] FEParamGetTiposTributo')
    const tributos = await feParamGetTiposTributo(auth)
    console.table(tributos)

    // Solo lectura: consulta el último comprobante autorizado del primer punto
    // de venta habilitado. No emite nada.
    if (ptosVenta.length > 0) {
      const pv = ptosVenta.find((p) => p.nro) || ptosVenta[0]
      console.log(`\n[10] FECompUltimoAutorizado (PtoVta=${pv.nro}, CbteTipo=1)` + '  [SOLO LECTURA]')
      try {
        const ultimo = await feCompUltimoAutorizado(auth, { ptoVta: pv.nro, cbteTipo: 1 })
        console.log(`  Último nro autorizado: ${ultimo.cbteNro}`)
      } catch (err) {
        console.log(`  FECompUltimoAutorizado ERROR: ${err.message}`)
      }
    }

    console.log('\nWSFEv1 HOMOLOGACIÓN: CONEXIÓN CORRECTA')
  } else {
    console.log('\nSin TA válido en nuestro poder: las consultas de parámetros requieren autenticación.')
    console.log('Cuando el TA vigente expire, WSAA emitirá uno nuevo y este script hará el flujo completo automáticamente.')
  }
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`)
  process.exitCode = 1
})
