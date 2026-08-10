/**
 * Utilidades puras de la emisión de CAE (sin red).
 *
 * - esCuitValido: dígito verificador CUIT (módulo 11).
 * - parseArgs: parser de CLI `--clave valor` / `--clave=valor`.
 * - validarDatosFactura: valida los datos de una factura contra los catálogos
 *   devueltos por ARCA (nada hardcodeado) y la consistencia de importes.
 * - validarImportes: total == neto + iva + exento + no gravado + tributos.
 */
export function esCuitValido(cuit) {
  const s = String(cuit ?? '').replace(/\D/g, '')
  if (!/^\d{11}$/.test(s)) return false
  const prefijo = s.slice(0, 2)
  if (!['20', '23', '24', '27', '30', '33', '34'].includes(prefijo)) return false

  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const base = s.slice(0, 10).split('').map(Number)
  const check = Number(s[10])
  let sum = 0
  for (let i = 0; i < 10; i++) sum += base[i] * pesos[i]
  const resto = sum % 11
  let dv = 11 - resto
  if (dv === 11) dv = 0
  if (dv === 10) dv = 9
  return dv === check
}

export function esFechaAfip(fecha) {
  return /^\d{8}$/.test(String(fecha ?? ''))
}

/** Redondeo a 2 decimales con la misma regla que AFIP. */
export function redondear2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}

/** total debe ser consistente con neto + iva + opEx + totConc + trib. */
export function validarImportes(datos) {
  const errores = []
  const suma = redondear2(
    (datos.impNeto ?? 0) +
    (datos.impIva ?? 0) +
    (datos.impOpEx ?? 0) +
    (datos.impTotConc ?? 0) +
    (datos.impTrib ?? 0)
  )
  const total = Number(datos.impTotal)
  if (!Number.isFinite(total) || total <= 0) {
    errores.push('impTotal debe ser un importe positivo.')
  } else if (Math.abs(redondear2(total) - suma) > 0.01) {
    errores.push(
      `Importes inconsistentes: impTotal=${total} pero neto+iva+exento+noGravado+tributos=${suma}.`
    )
  }
  const ivaDeclarado = redondear2(datos.impIva ?? 0)
  const ivaDeAlicuotas = redondear2((datos.iva ?? []).reduce((acc, a) => acc + Number(a.importe), 0))
  if (Math.abs(ivaDeclarado - ivaDeAlicuotas) > 0.01) {
    errores.push(
      `impIva=${ivaDeclarado} no coincide con la suma de alícuotas=${ivaDeAlicuotas}.`
    )
  }
  const netoDeclarado = redondear2(datos.impNeto ?? 0)
  const baseDeAlicuotas = redondear2((datos.iva ?? []).reduce((acc, a) => acc + Number(a.baseImp), 0))
  if (Math.abs(netoDeclarado - baseDeAlicuotas) > 0.01) {
    errores.push(
      `impNeto=${netoDeclarado} no coincide con la suma de bases imponibles=${baseDeAlicuotas}.`
    )
  }
  return errores
}

/**
 * Valida datosFactura contra los catálogos de ARCA.
 *
 * @param {object} datos - { ptoVta, cbteTipo, concepto, docTipo, docNro,
 *   cbteFch, monId, impTotal, impNeto, impIva, impOpEx, impTotConc, impTrib, iva[] }
 * @param {object} catalogo - { ptosVenta, tiposCbte, tiposDoc, tiposIva, monedas }
 *   (resultados de FEParamGet*).
 * @returns {{ ok: boolean, errores: string[] }}
 */
export function validarDatosFactura(datos, catalogo) {
  const errores = []

  if (!catalogo?.ptosVenta || !catalogo?.tiposCbte) {
    errores.push('Catálogos de ARCA incompletos: no se pudo validar contra WSFE.')
    return { ok: false, errores }
  }

  const pv = catalogo.ptosVenta.find((p) => String(p.nro) === String(datos.ptoVta))
  if (!pv) {
    errores.push(`Punto de venta ${datos.ptoVta} no está habilitado para este CUIT en ARCA.`)
  } else if (pv.bloqueado) {
    errores.push(`Punto de venta ${datos.ptoVta} está bloqueado en ARCA.`)
  }

  const cbte = catalogo.tiposCbte.find((t) => String(t.id) === String(datos.cbteTipo))
  if (!cbte) {
    errores.push(`Tipo de comprobante ${datos.cbteTipo} no existe en ARCA.`)
  }

  if (datos.docTipo == null) {
    errores.push('Falta docTipo (ej: 80 para CUIT).')
  } else {
    const doc = catalogo.tiposDoc.find((t) => String(t.id) === String(datos.docTipo))
    if (!doc) errores.push(`Tipo de documento ${datos.docTipo} no existe en ARCA.`)
  }

  if (datos.docNro == null || datos.docNro === '') {
    errores.push('Falta docNro del receptor.')
  } else if (String(datos.docTipo) === '80' && !esCuitValido(datos.docNro)) {
    errores.push(`docNro ${datos.docNro} no es un CUIT válido (dígito verificador incorrecto).`)
  }

  if (!esFechaAfip(datos.cbteFch)) {
    errores.push(`cbteFch debe tener formato YYYYMMDD (recibido: ${datos.cbteFch}).`)
  }

  if (datos.monId) {
    const mon = catalogo.monedas?.find((m) => String(m.id) === String(datos.monId))
    if (!mon) errores.push(`Moneda ${datos.monId} no existe en ARCA.`)
  }

  for (const alicuota of datos.iva ?? []) {
    const existe = catalogo.tiposIva?.some((t) => String(t.id) === String(alicuota.id))
    if (!existe) errores.push(`Alícuota de IVA id=${alicuota.id} no existe en ARCA.`)
  }

  errores.push(...validarImportes(datos))

  return { ok: errores.length === 0, errores }
}

/**
 * Parser de argumentos: --clave valor o --clave=valor.
 * Devuelve { [clave]: valor }. Los valores se intentan convertir a número
 * cuando la clave lo requiere (ptoVta, cbteTipo, docTipo, importes, iva...).
 */
export function parseArgs(argv) {
  const out = {}
  const NUMERIC = new Set([
    'ptoVta', 'cbteTipo', 'concepto', 'docTipo', 'docNro',
    'impTotal', 'impNeto', 'impIva', 'impOpEx', 'impTotConc', 'impTrib', 'cotiz',
    'iva21', 'iva105', 'iva27',
  ])
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (!raw.startsWith('--')) continue
    const body = raw.slice(2)
    const eq = body.indexOf('=')
    let key
    let value
    if (eq !== -1) {
      key = body.slice(0, eq)
      value = body.slice(eq + 1)
    } else {
      key = body
      value = argv[i + 1] ?? ''
      if (value.startsWith('--')) value = ''
      else i += 1
    }
    if (!key) continue
    out[key] = NUMERIC.has(key) && value !== '' ? Number(value) : value
  }
  return out
}

/**
 * Lista los campos que faltan para construir la factura de prueba.
 */
export function camposFaltantes(args) {
  const requeridos = [
    ['ptoVta', 'punto de venta (--ptoVta, ej: 1)'],
    ['cbteTipo', 'tipo de comprobante (--cbteTipo, ej: 1)'],
    ['docTipo', 'tipo de documento receptor (--docTipo, ej: 80)'],
    ['docNro', 'número de documento receptor (--docNro, CUIT)'],
    ['impNeto', 'importe neto gravado (--impNeto)'],
    ['impIva', 'importe de IVA (--impIva)'],
    ['impTotal', 'importe total (--impTotal)'],
  ]
  return requeridos.filter(([key]) => args[key] == null || args[key] === '').map(([, label]) => label)
}
