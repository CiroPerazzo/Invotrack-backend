/**
 * WSFEv1 (ARCA) - Cliente de Facturación Electrónica, ambiente de HOMOLOGACIÓN.
 *
 * Endpoint: https://wswhomo.afip.gov.ar/wsfev1/service.asmx
 * Namespace: http://ar.gov.afip.dif.FEV1/
 *
 * Usa la autenticación WSAA existente (./wsaa.js) para obtener/reutilizar el TA.
 * Nunca imprime token ni sign.
 */
import { XMLParser } from 'fast-xml-parser'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { getTokenAndSign } from './wsaa.js'

const WSFEv1_HOMOLOGACION = 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx'
const NS_WSFE = 'http://ar.gov.afip.dif.FEV1/'

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, trimValues: true })

const toArray = (x) => (Array.isArray(x) ? x : x == null ? [] : [x])

function parseEnvelope(xml) {
  const obj = parser.parse(xml)
  const body = obj?.Envelope?.Body
  if (!body) throw new Error('Respuesta SOAP sin <Body>')
  if (body.Fault) {
    const f = body.Fault
    throw new Error(`WSFEv1 fault: ${f.faultstring || f.faultcode || 'desconocido'}`)
  }
  return body
}

function extractResult(body, method) {
  const response = body[`${method}Response`]
  if (!response) throw new Error(`Respuesta sin <${method}Response>`)
  return response[`${method}Result`]
}

function errorsOf(result) {
  if (!result?.Errors) return []
  return toArray(result.Errors.Err).map((e) => ({ code: e.Code, msg: e.Msg }))
}

function assertNoErrors(result, context) {
  const errs = errorsOf(result)
  if (errs.length) {
    throw new Error(`${context} -> errores ARCA: ${errs.map((e) => `${e.code}: ${e.msg}`).join(' | ')}`)
  }
}

async function call(method, auth, paramsXml = '') {
  const authXml = auth
    ? `<Auth><Token>${auth.token}</Token><Sign>${auth.sign}</Sign><Cuit>${auth.cuit}</Cuit></Auth>`
    : ''
  const body =
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">` +
    `<soap:Body><${method} xmlns="${NS_WSFE}">${authXml}${paramsXml}</${method}></soap:Body></soap:Envelope>`

  const response = await fetch(WSFEv1_HOMOLOGACION, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `${NS_WSFE}${method}`,
    },
    body,
  })
  const xml = await response.text()
  return parseEnvelope(xml)
}

// ---------------------------------------------------------------------------
// Consultas de parámetros
// ---------------------------------------------------------------------------

/** FEDummy: no requiere autenticación (WSDL: <FEDummy/>). */
export async function feDummy(auth = null) {
  const body = await call('FEDummy', auth)
  const result = extractResult(body, 'FEDummy')
  return { AppServer: result?.AppServer, DbServer: result?.DbServer, AuthServer: result?.AuthServer }
}

export async function feParamGetPtosVenta(auth) {
  const body = await call('FEParamGetPtosVenta', auth)
  const result = extractResult(body, 'FEParamGetPtosVenta')
  assertNoErrors(result, 'FEParamGetPtosVenta')
  return toArray(result?.ResultGet?.PtoVenta).map((p) => ({
    nro: p.Nro,
    emisionTipo: p.EmisionTipo,
    bloqueado: p.Bloqueado,
    fchBaja: p.FchBaja,
  }))
}

export async function feParamGetTiposCbte(auth) {
  const body = await call('FEParamGetTiposCbte', auth)
  const result = extractResult(body, 'FEParamGetTiposCbte')
  assertNoErrors(result, 'FEParamGetTiposCbte')
  return toArray(result?.ResultGet?.CbteTipo).map((t) => ({
    id: t.Id,
    desc: t.Desc,
    fchDesde: t.FchDesde,
    fchHasta: t.FchHasta,
  }))
}

export async function feParamGetTiposDoc(auth) {
  const body = await call('FEParamGetTiposDoc', auth)
  const result = extractResult(body, 'FEParamGetTiposDoc')
  assertNoErrors(result, 'FEParamGetTiposDoc')
  return toArray(result?.ResultGet?.DocTipo).map((t) => ({
    id: t.Id,
    desc: t.Desc,
    fchDesde: t.FchDesde,
    fchHasta: t.FchHasta,
  }))
}

export async function feParamGetCondicionIvaReceptor(auth) {
  const body = await call('FEParamGetCondicionIvaReceptor', auth)
  const result = extractResult(body, 'FEParamGetCondicionIvaReceptor')
  assertNoErrors(result, 'FEParamGetCondicionIvaReceptor')
  return toArray(result?.ResultGet?.CondicionIvaReceptor).map((c) => ({
    id: c.Id,
    desc: c.Desc,
    cmpClase: c.Cmp_Clase,
  }))
}

export async function feParamGetTiposIva(auth) {
  const body = await call('FEParamGetTiposIva', auth)
  const result = extractResult(body, 'FEParamGetTiposIva')
  assertNoErrors(result, 'FEParamGetTiposIva')
  return toArray(result?.ResultGet?.AlicIva).map((a) => ({
    id: a.Id,
    desc: a.Desc,
    fchDesde: a.FchDesde,
    fchHasta: a.FchHasta,
  }))
}

export async function feParamGetMonedas(auth) {
  const body = await call('FEParamGetMonedas', auth)
  const result = extractResult(body, 'FEParamGetMonedas')
  assertNoErrors(result, 'FEParamGetMonedas')
  return toArray(result?.ResultGet?.Moneda).map((m) => ({
    id: m.Id,
    desc: m.Desc,
    fchDesde: m.FchDesde,
    fchHasta: m.FchHasta,
  }))
}

export async function feParamGetTiposTributo(auth) {
  const body = await call('FEParamGetTiposTributo', auth)
  const result = extractResult(body, 'FEParamGetTiposTributo')
  assertNoErrors(result, 'FEParamGetTiposTributo')
  return toArray(result?.ResultGet?.Tributo).map((t) => ({
    id: t.Id,
    desc: t.Desc,
    fchDesde: t.FchDesde,
    fchHasta: t.FchHasta,
  }))
}

// ---------------------------------------------------------------------------
// Comprobantes
// ---------------------------------------------------------------------------

/** Último número autorizado para un punto de venta + tipo de comprobante. */
export async function feCompUltimoAutorizado(auth, { ptoVta, cbteTipo }) {
  const body = await call(
    'FECompUltimoAutorizado',
    auth,
    `<PtoVta>${ptoVta}</PtoVta><CbteTipo>${cbteTipo}</CbteTipo>`
  )
  const result = extractResult(body, 'FECompUltimoAutorizado')
  assertNoErrors(result, `FECompUltimoAutorizado (PtoVta=${ptoVta}, CbteTipo=${cbteTipo})`)
  return { ptoVta: result.PtoVta, cbteTipo: result.CbteTipo, cbteNro: result.CbteNro }
}

/** Consulta un comprobante ya emitido (solo lectura; no emite nada). */
export async function feCompConsultar(auth, { ptoVta, cbteTipo, cbteNro }) {
  const body = await call(
    'FECompConsultar',
    auth,
    `<FeConsReq>` +
    `<CbteTipo>${cbteTipo}</CbteTipo>` +
    `<CbtePtoVta>${ptoVta}</CbtePtoVta>` +
    `<CbteNro>${cbteNro}</CbteNro>` +
    `</FeConsReq>`
  )
  const result = extractResult(body, 'FECompConsultar')
  assertNoErrors(result, `FECompConsultar (PtoVta=${ptoVta}, CbteTipo=${cbteTipo}, CbteNro=${cbteNro})`)
  const r = result?.ResultGet
  if (!r) return null
  return {
    cbteNro: r.CbteNro,
    cbteTipo: r.CbteTipo,
    ptoVta: r.PtoVta,
    resultado: r.Resultado,
    cbteFch: r.CbteFch,
    impTotal: r.ImpTotal,
    impNeto: r.ImpNeto,
    impIva: r.ImpIVA,
    impOpEx: r.ImpOpEx,
    impTotConc: r.ImpTotConc,
    impTrib: r.ImpTrib,
    cae: r.CAE,
    caeFchVto: r.CAEFchVto,
    docTipo: r.DocTipo,
    docNro: r.DocNro,
  }
}

/**
 * Próximo número para un punto de venta + tipo de comprobante, consultando a
 * ARCA (FECompUltimoAutorizado). Nunca hardcodear el número de factura.
 */
export async function obtenerSiguienteNumero(auth, { ptoVta, cbteTipo }) {
  const ultimo = await feCompUltimoAutorizado(auth, { ptoVta, cbteTipo })
  return { numero: ultimo.cbteNro + 1, ultimoAutorizado: ultimo.cbteNro }
}

/**
 * Solicita CAE vía FECAESolicitar (NO se llama por defecto; queda preparada).
 *
 * Si datosFactura no trae cbteNro, se consulta FECompUltimoAutorizado para
 * determinar el siguiente número (no se hardcodea).
 *
 * datosFactura (campos mínimos):
 *   ptoVta, cbteTipo,
 *   cbteNro (opcional; si falta se calcula con ARCA),
 *   cbteFch (YYYYMMDD),
 *   concepto, docTipo, docNro,
 *   impTotal, impTotConc, impNeto, impOpEx, impIva, impTrib,
 *   monId ('PES'), monCotiz (1),
 *   iva: [{ id, baseImp, importe }]
 */
export async function solicitarCAE(auth, datosFactura) {
  const d = { ...datosFactura }

  if (d.cbteNro == null) {
    const siguiente = await obtenerSiguienteNumero(auth, { ptoVta: d.ptoVta, cbteTipo: d.cbteTipo })
    d.cbteNro = siguiente.numero
  }

  const ivaXml = (d.iva || [])
    .map((a) => `<AlicIva><Id>${a.id}</Id><BaseImp>${a.baseImp}</BaseImp><Importe>${a.importe}</Importe></AlicIva>`)
    .join('')
  const det = `
  <FECAEDetRequest>
    <Concepto>${d.concepto ?? 1}</Concepto>
    <DocTipo>${d.docTipo}</DocTipo>
    <DocNro>${d.docNro}</DocNro>
    <CbteDesde>${d.cbteNro}</CbteDesde>
    <CbteHasta>${d.cbteNro}</CbteHasta>
    <CbteFch>${d.cbteFch}</CbteFch>
    <ImpTotal>${d.impTotal}</ImpTotal>
    <ImpTotConc>${d.impTotConc ?? 0}</ImpTotConc>
    <ImpNeto>${d.impNeto}</ImpNeto>
    <ImpOpEx>${d.impOpEx ?? 0}</ImpOpEx>
    <ImpTrib>${d.impTrib ?? 0}</ImpTrib>
    <ImpIVA>${d.impIva}</ImpIVA>
    ${d.fchServDesde ? `<FchServDesde>${d.fchServDesde}</FchServDesde>` : ''}
    ${d.fchServHasta ? `<FchServHasta>${d.fchServHasta}</FchServHasta>` : ''}
    ${d.fchVtoPago ? `<FchVtoPago>${d.fchVtoPago}</FchVtoPago>` : ''}
    <MonId>${d.monId ?? 'PES'}</MonId>
    <MonCotiz>${d.monCotiz ?? 1}</MonCotiz>
    ${ivaXml ? `<Iva>${ivaXml}</Iva>` : ''}
  </FECAEDetRequest>`

  const body = await call(
    'FECAESolicitar',
    auth,
    `<FeCAEReq>` +
    `<FeCabReq><CantReg>1</CantReg><PtoVta>${d.ptoVta}</PtoVta><CbteTipo>${d.cbteTipo}</CbteTipo></FeCabReq>` +
    `<FeDetReq>${det}</FeDetReq>` +
    `</FeCAEReq>`
  )
  const result = extractResult(body, 'FECAESolicitar')

  const detResp = toArray(result?.FeDetResp?.FECAEDetResponse)
  const errores = errorsOf(result)
  const observaciones = detResp.flatMap((det) =>
    toArray(det?.Observaciones?.Obs).map((o) => ({ code: o.Code, msg: o.Msg }))
  )
  const ok = errores.length === 0 && detResp.length > 0 && detResp.every((det) => det.Resultado === 'A')

  return {
    ok,
    ptoVta: d.ptoVta,
    cbteTipo: d.cbteTipo,
    cbteNro: d.cbteNro,
    resultadoCabecera: result?.FeCabResp?.Resultado ?? null,
    cae: detResp[0]?.CAE ?? null,
    caeVencimiento: detResp[0]?.CAEFchVto ?? null,
    comprobante: detResp[0]
      ? {
          cbteDesde: detResp[0].CbteDesde,
          cbteHasta: detResp[0].CbteHasta,
          cbteFch: detResp[0].CbteFch,
          resultado: detResp[0].Resultado,
        }
      : null,
    errores,
    observaciones,
  }
}

/**
 * Hash estable de los datos comerciales de una factura (sin cbteNro).
 * Sirve para saber si un intento pendiente corresponde a la MISMA factura.
 */
export function hashDatosFactura(datos) {
  const relevante = {
    ptoVta: datos.ptoVta,
    cbteTipo: datos.cbteTipo,
    concepto: datos.concepto ?? 1,
    docTipo: datos.docTipo,
    docNro: datos.docNro,
    cbteFch: datos.cbteFch,
    impTotal: String(datos.impTotal),
    impTotConc: String(datos.impTotConc ?? 0),
    impNeto: String(datos.impNeto),
    impOpEx: String(datos.impOpEx ?? 0),
    impTrib: String(datos.impTrib ?? 0),
    impIva: String(datos.impIva),
    monId: datos.monId ?? 'PES',
    monCotiz: String(datos.monCotiz ?? 1),
    iva: (datos.iva ?? []).map((a) => [a.id, String(a.baseImp), String(a.importe)]),
  }
  return createHash('sha256').update(JSON.stringify(relevante)).digest('hex').slice(0, 20)
}

/**
 * Normaliza la respuesta de ARCA en un registro listo para persistir.
 * Nunca considera autorizada una factura solo porque el HTTP respondió bien:
 * se basa en la respuesta funcional (Resultado A y CAE presente).
 */
export function procesarRespuestaCae(respuesta) {
  const estado = respuesta.ok
    ? 'AUTORIZADO'
    : (respuesta.errores?.length > 0 ? 'RECHAZADO' : 'VERIFICAR_ARCA')
  return {
    puntoVenta: respuesta.ptoVta,
    tipoComprobante: respuesta.cbteTipo,
    numero: respuesta.cbteNro,
    fechaEmision: respuesta.comprobante?.cbteFch ?? null,
    estado,
    resultado: respuesta.resultadoCabecera,
    cae: respuesta.cae ?? null,
    caeVencimiento: respuesta.caeVencimiento ?? null,
    errores: respuesta.errores ?? [],
    observaciones: respuesta.observaciones ?? [],
  }
}

/**
 * Emisión idempotente de CAE.
 *
 * Protección contra el escenario: InvoTrack envía FECAESolicitar → ARCA
 * autoriza → se corta Internet antes de recibir la respuesta. Si se
 * re-ejecutara a ciegas, se emitiría un comprobante duplicado.
 *
 * Estrategia:
 *  - Antes del primer envío se registra un "intento" (ptoVta, cbteTipo,
 *    cbteNro, hash de los datos) con estado PENDIENTE_ARCA.
 *  - Si ya existe un intento pendiente para ese ptoVta+cbteTipo, se consulta
 *    FECompConsultar:
 *      · Si ARCA dice que el comprobante existe y está autorizado → se
 *        recupera el CAE y NO se reenvía FECAESolicitar.
 *      · Si ARCA dice que no existe → se reintenta con el MISMO número
 *        (seguro, porque nunca se autorizó).
 *      · Si la consulta falla (otra caída) → se aborta con un mensaje claro y
 *        el intento queda pendiente para reintentar más tarde.
 *  - Si no hay intento pendiente: FECompUltimoAutorizado → número siguiente →
 *    registrar intento → FECAESolicitar.
 *
 * @param {object} deps - Inyección para persistir intentos y simular la red
 *   (permite testear sin contactar ARCA):
 *   - cargarIntento({ptoVta, cbteTipo}) -> intento | null
 *   - guardarIntento(intento)
 *   - ultimoAutorizado(auth, {ptoVta, cbteTipo})
 *   - consultarCAEExistente(auth, {ptoVta, cbteTipo, cbteNro}) -> comprobante | null
 *   - enviarCAE(auth, datosFactura) -> respuesta de solicitarCAE
 */
export async function emitirCaeIdempotente(auth, datosFactura, deps = {}) {
  const {
    cargarIntento = () => null,
    guardarIntento = () => {},
    ultimoAutorizado = (a, q) => feCompUltimoAutorizado(a, q),
    consultarCAEExistente = (a, q) => feCompConsultar(a, q),
    enviarCAE = (a, d) => solicitarCAE(a, d),
  } = deps

  const ptoVta = datosFactura.ptoVta
  const cbteTipo = datosFactura.cbteTipo
  const hash = hashDatosFactura(datosFactura)

  const intento = cargarIntento({ ptoVta, cbteTipo })
  if (intento) {
    if (intento.hash !== hash) {
      throw new Error(
        `Ya existe un intento pendiente para (PtoVta=${ptoVta}, CbteTipo=${cbteTipo}) con OTROS datos. ` +
        `No se puede sobrescribir. Revisar antes de continuar.`
      )
    }
    try {
      const existente = await consultarCAEExistente(auth, {
        ptoVta,
        cbteTipo,
        cbteNro: intento.cbteNro,
      })
      if (existente) {
        const recuperado = {
          ok: true,
          ptoVta,
          cbteTipo,
          cbteNro: existente.cbteNro,
          resultadoCabecera: 'A',
          cae: existente.cae,
          caeVencimiento: existente.caeFchVto,
          comprobante: {
            cbteDesde: existente.cbteNro,
            cbteHasta: existente.cbteNro,
            cbteFch: existente.cbteFch,
            resultado: existente.resultado,
          },
          errores: [],
          observaciones: [],
          recuperado: true,
        }
        guardarIntento({ ...intento, estado: 'AUTORIZADO', respuesta: recuperado })
        return recuperado
      }
    } catch (err) {
      throw new Error(
        `No se pudo verificar si el comprobante Nro ${intento.cbteNro} (PtoVta=${ptoVta}, ` +
        `CbteTipo=${cbteTipo}) fue autorizado por ARCA: ${err.message}. ` +
        `El intento quedó PENDIENTE_ARCA; reintentá sin cambiar los datos.`,
        { cause: err }
      )
    }

    // ARCA no tiene ese comprobante: reintentar con el MISMO número.
    const respuesta = await enviarCAE(auth, { ...datosFactura, cbteNro: intento.cbteNro })
    guardarIntento({ ...intento, estado: respuesta.ok ? 'AUTORIZADO' : 'RECHAZADO', respuesta })
    return respuesta
  }

  // Primer intento: calcular el número con ARCA (nunca hardcodear).
  const ultimo = await ultimoAutorizado(auth, { ptoVta, cbteTipo })
  const cbteNro = ultimo.cbteNro + 1
  const intentoRecord = {
    ptoVta,
    cbteTipo,
    cbteNro,
    hash,
    estado: 'PENDIENTE_ARCA',
    intentos: 1,
    fecha: new Date().toISOString(),
  }
  guardarIntento(intentoRecord)

  const respuesta = await enviarCAE(auth, { ...datosFactura, cbteNro })
  guardarIntento({ ...intentoRecord, estado: respuesta.ok ? 'AUTORIZADO' : 'RECHAZADO', respuesta })
  return respuesta
}

// ---------------------------------------------------------------------------
// CLI directo: node scripts/arca/wsfe-client.js
// ---------------------------------------------------------------------------

async function mainQueries() {
  const auth = await getTokenAndSign()
  console.log(`WSAA: TA ${auth.reused ? 'reutilizado' : 'obtenido'}. Expira: ${auth.expirationTime}\n`)

  const dummy = await feDummy(auth)
  console.log('FEDummy:', dummy)

  const ptosVenta = await feParamGetPtosVenta(auth)
  console.log('\nPuntos de venta:')
  console.table(ptosVenta)

  const tiposCbte = await feParamGetTiposCbte(auth)
  console.log('\nTipos de comprobante:')
  console.table(tiposCbte)

  const tiposDoc = await feParamGetTiposDoc(auth)
  console.log('\nTipos de documento:')
  console.table(tiposDoc)

  const condIva = await feParamGetCondicionIvaReceptor(auth)
  console.log('\nCondiciones de IVA del receptor:')
  console.table(condIva)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  mainQueries()
    .then(() => console.log('\nWSFEv1 HOMOLOGACIÓN: CONEXIÓN CORRECTA'))
    .catch((err) => {
      console.error(`ERROR: ${err.message}`)
      process.exitCode = 1
    })
}
