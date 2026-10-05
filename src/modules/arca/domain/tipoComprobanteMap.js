/**
 * Mapa tipo comprobante InvoTrack → código AFIP (CbteTipo).
 * @see https://docs.afipsdk.com/siguientes-pasos/web-services/factura-electronica/factura-b.md
 */
export const TIPO_COMPROBANTE_TO_AFIP = {
  'Factura A': 1,
  'Nota de Débito A': 2,
  'Nota de Crédito A': 3,
  'Factura B': 6,
  'Nota de Débito B': 7,
  'Nota de Crédito B': 8,
  'Factura C': 11,
  'Nota de Débito C': 12,
  'Nota de Crédito C': 13,
  'Factura M': 51,
  'Nota de Débito M': 52,
  'Nota de Crédito M': 53,
}

/** Tipos soportados en la emisión MVP. */
export const EMIT_SUPPORTED_TYPES = ['Factura B']

export function getAfipCbteTipo(tipoComprobante) {
  const code = TIPO_COMPROBANTE_TO_AFIP[tipoComprobante]
  if (!code) {
    throw new Error(`Tipo de comprobante no soportado para emisión: ${tipoComprobante}`)
  }
  return code
}

/**
 * Condición IVA receptor (InvoTrack) → CondicionIVAReceptorId ARCA.
 */
export const CONDICION_IVA_RECEPTOR_MAP = {
  RI: 1,
  EX: 4,
  CF: 5,
  MO: 6,
  RS: 1,
}

/**
 * Alícuota IVA (%) → Id alícuota AFIP.
 */
export const IVA_ALICUOTA_MAP = {
  0: 3,
  10.5: 4,
  21: 5,
  27: 6,
}

export function stripCuit(cuit) {
  if (!cuit) return 0
  return Number(String(cuit).replace(/\D/g, ''))
}

export function formatCaeVencimiento(caeFchVto) {
  if (!caeFchVto) return null
  const str = String(caeFchVto)
  if (str.length === 8) {
    return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`
  }
  return str
}

export function toAfipDate(isoDate) {
  return Number(String(isoDate).replace(/-/g, ''))
}
