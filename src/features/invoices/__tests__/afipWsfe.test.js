import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  CBTE_TIPO_MAP,
  getCbteTipo,
  numeroAfip,
  fechaEmisionToAfip,
  afipDateToIso,
  computeIvaFromItems,
  mapInvoiceToCaeRequest,
  buildFeCAEReq,
  buildDetalle,
  parseCaeResponse,
  parseFeCompUltimoAutorizado,
} from '../../../../supabase/functions/_shared/afipWsfe.js'

// ── Mapeos AFIP ────────────────────────────────────────────────────────────

describe('getCbteTipo (WSFEv1)', () => {
  it('mapea los tipos de comprobante de InvoTrack a los códigos de AFIP', () => {
    expect(CBTE_TIPO_MAP['Factura A']).toBe(1)
    expect(CBTE_TIPO_MAP['Factura B']).toBe(6)
    expect(CBTE_TIPO_MAP['Factura C']).toBe(11)
    expect(CBTE_TIPO_MAP['Factura M']).toBe(20)
    expect(CBTE_TIPO_MAP['Nota de Crédito B']).toBe(8)
    expect(CBTE_TIPO_MAP['Nota de Débito A']).toBe(2)
    expect(CBTE_TIPO_MAP['Recibo C']).toBe(15)
  })

  it('lanza para tipos que no se emiten con CAE', () => {
    expect(() => getCbteTipo('Remito')).toThrow(/no se puede emitir con CAE/i)
    expect(() => getCbteTipo('Presupuesto')).toThrow(/no se puede emitir con CAE/i)
  })
})

describe('formato de números y fechas (WSFEv1)', () => {
  it('numeroAfip usa punto decimal y 2 dígitos', () => {
    expect(numeroAfip(1234.5)).toBe('1234.50')
    expect(numeroAfip('9876')).toBe('9876.00')
    expect(numeroAfip(0)).toBe('0.00')
    expect(numeroAfip(undefined)).toBe('0.00')
  })

  it('fechaEmisionToAfip convierte ISO a YYYYMMDD', () => {
    expect(fechaEmisionToAfip('2024-01-15')).toBe('20240115')
    expect(fechaEmisionToAfip('2024-12-31T23:59:59')).toBe('20241231')
  })

  it('afipDateToIso convierte YYYYMMDD a ISO', () => {
    expect(afipDateToIso('20240115')).toBe('2024-01-15')
    expect(afipDateToIso('2024-01-15')).toBe('2024-01-15')
  })
})

// ── Cálculo de IVA por alícuota ────────────────────────────────────────────

describe('computeIvaFromItems (WSFEv1)', () => {
  it('agrupa bases por alícuota y calcula el importe', () => {
    const iva = computeIvaFromItems([
      { cantidad: 2, precio_unitario: 100, alicuota_iva: 21 },
      { cantidad: 1, precio_unitario: 50, alicuota_iva: 21 },
      { cantidad: 10, precio_unitario: 10, alicuota_iva: 10.5 },
      { cantidad: 5, precio_unitario: 20, alicuota_iva: 0 },
    ])
    expect(iva).toEqual([
      { id: 4, baseImp: 100, importe: 10.5 },
      { id: 5, baseImp: 250, importe: 52.5 },
    ])
  })

  it('invariante: el importe de cada alícuota es base × tasa/100 (propiedad)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            cantidad: fc.float({ min: 0.5, max: 100, noNaN: true }),
            precio: fc.float({ min: 1, max: 1000, noNaN: true }),
            rate: fc.constantFrom(0, 10.5, 21, 27),
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (items) => {
          const iva = computeIvaFromItems(
            items.map(({ cantidad, precio, rate }) => ({
              cantidad,
              precio_unitario: precio,
              alicuota_iva: rate,
            }))
          )
          const rateToId = { 10.5: 4, 21: 5, 27: 6 }
          const activeRates = [...new Set(items.filter((i) => i.rate !== 0).map((i) => i.rate))]

          // Cada alícuota con base > 0 debe estar presente, y ninguna otra
          expect(iva.map((a) => a.id).sort()).toEqual(activeRates.map((r) => rateToId[r]).sort())

          // El importe de cada alícuota es base × tasa/100 (con redondeo a 2 decimales)
          for (const a of iva) {
            const rate = Object.keys(rateToId).find((r) => rateToId[r] === a.id)
            const expected = Math.round((a.baseImp * Number(rate) / 100 + Number.EPSILON) * 100) / 100
            expect(a.importe).toBeCloseTo(expected, 2)
          }

          // La suma de las bases coincide con la suma de cantidad×precio por tasa
          for (const rate of activeRates) {
            const expectedBase = items
              .filter((i) => i.rate === rate)
              .reduce((acc, i) => acc + i.cantidad * i.precio, 0)
            const alicuota = iva.find((a) => a.id === rateToId[rate])
            expect(alicuota.baseImp).toBeCloseTo(expectedBase, 1)
          }
          return true
        }
      ),
      { numRuns: 50 }
    )
  })
})

// ── Construcción del request FECAESolicitar ────────────────────────────────

describe('mapInvoiceToCaeRequest + buildFeCAEReq (WSFEv1)', () => {
  it('genera el XML con los datos del comprobante', () => {
    const invoice = {
      tipo_comprobante: 'Factura A',
      punto_de_venta: 2,
      numero_comprobante: 15,
      fecha_emision: '2024-05-10',
      moneda: 'ARS',
      tipo_cambio: 1,
      receptor_cuit: '30-99999999-1',
      consumidor_final_anonimo: false,
      neto_gravado: 826.45,
      neto_no_gravado: 0,
      exento: 0,
      iva_105: 0,
      iva_21: 173.55,
      iva_27: 0,
      otros_tributos: 10,
      total_amount: 1010,
      items: [{ cantidad: 1, precio_unitario: 826.45, alicuota_iva: 21 }],
    }
    const { cabecera, detalle } = mapInvoiceToCaeRequest({ invoice, cbteTipo: getCbteTipo('Factura A') })
    const xml = buildFeCAEReq({ cabecera, detalle })

    expect(cabecera).toEqual({ ptoVta: 2, cbteTipo: 1, cantReg: 1 })
    expect(xml).toContain('<PtoVta>2</PtoVta>')
    expect(xml).toContain('<CbteTipo>1</CbteTipo>')
    expect(xml).toContain('<CbteDesde>15</CbteDesde>')
    expect(xml).toContain('<CbteFch>20240510</CbteFch>')
    expect(xml).toContain('<DocNro>30999999991</DocNro>')
    expect(xml).toContain('<ImpNeto>826.45</ImpNeto>')
    expect(xml).toContain('<ImpIVA>173.55</ImpIVA>')
    expect(xml).toContain('<ImpTrib>10.00</ImpTrib>')
    expect(xml).toContain('<ImpTotal>1010.00</ImpTotal>')
    expect(xml).toContain('<MonId>PES</MonId>')
    expect(xml).toContain('<Iva><AlicIva><Id>5</Id><BaseImp>826.45</BaseImp><Importe>173.55</Importe></AlicIva></Iva>')
  })

  it('consumidor final anónimo → DocTipo 80 con DocNro 0', () => {
    const invoice = {
      tipo_comprobante: 'Factura B',
      punto_de_venta: 1,
      numero_comprobante: 3,
      fecha_emision: '2024-05-10',
      moneda: 'ARS',
      tipo_cambio: 1,
      receptor_cuit: '',
      consumidor_final_anonimo: true,
      neto_gravado: 500,
      total_amount: 605,
      items: [{ cantidad: 1, precio_unitario: 500, alicuota_iva: 21 }],
    }
    const { cabecera, detalle } = mapInvoiceToCaeRequest({ invoice, cbteTipo: getCbteTipo('Factura B') })
    const xml = buildFeCAEReq({ cabecera, detalle })
    expect(xml).toContain('<DocTipo>80</DocTipo>')
    expect(xml).toContain('<DocNro>0</DocNro>')
  })

  it('concepto 2 incluye las fechas de servicio y vencimiento de pago', () => {
    const xml = buildDetalle({
      concepto: 2,
      docTipo: 80,
      docNro: 30500000000,
      cbteDesde: 1,
      cbteFch: '20240510',
      impTotal: 100,
      impNeto: 82.64,
      impIVA: 17.36,
      monId: 'PES',
      iva: [],
    })
    expect(xml).toContain('<FchServDesde>20240510</FchServDesde>')
    expect(xml).toContain('<FchServHasta>20240510</FchServHasta>')
    expect(xml).toContain('<FchVtoPago>20240510</FchVtoPago>')
  })
})

// ── Parseo de respuestas ───────────────────────────────────────────────────

const CAE_OK_XML = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
<soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/">
<FECAESolicitarResult>
<FeCabResp><Cuit>20111111112</Cuit><PtoVta>1</PtoVta><CbteTipo>6</CbteTipo><Resultado>A</Resultado><Reproceso>N</Reproceso></FeCabResp>
<FeDetResp><FECAEDetResponse><Concepto>1</Concepto><DocTipo>80</DocTipo><DocNro>0</DocNro><CbteDesde>1</CbteDesde><CbteHasta>1</CbteHasta><CbteFch>20240510</CbteFch><Resultado>A</Resultado><CAE>73621758752880</CAE><CAEFchVto>20240520</CAEFchVto></FECAEDetResponse></FeDetResp>
</FECAESolicitarResult>
</FECAESolicitarResponse>
</soap:Body></soap:Envelope>`

const CAE_ERROR_XML = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/">
<FECAESolicitarResult>
<FeCabResp><Cuit>20111111112</Cuit><PtoVta>1</PtoVta><CbteTipo>6</CbteTipo><Resultado>R</Resultado><Reproceso>N</Reproceso></FeCabResp>
<Errores><Err><Code>10016</Code><Msg>No se puede ingresar el comprobante ya que falta consignar el punto de venta en el requerimiento.</Msg></Err></Errores>
</FECAESolicitarResult>
</FECAESolicitarResponse>
</soap:Body></soap:Envelope>`

const ULTIMO_AUTORIZADO_XML = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body><FECompUltimoAutorizadoResponse xmlns="http://ar.gov.afip.dif.FEV1/">
<FECompUltimoAutorizadoResult><PtoVta>1</PtoVta><CbteTipo>6</CbteTipo><CbteNro>3</CbteNro></FECompUltimoAutorizadoResult>
</FECompUltimoAutorizadoResponse>
</soap:Body></soap:Envelope>`

describe('parseCaeResponse (WSFEv1)', () => {
  it('extrae CAE, vencimiento e indicador de resultado aprobado', () => {
    const parsed = parseCaeResponse(CAE_OK_XML)
    expect(parsed.ok).toBe(true)
    expect(parsed.resultado).toBe('A')
    expect(parsed.cae).toBe('73621758752880')
    expect(parsed.caeVencimiento).toBe('2024-05-20')
    expect(parsed.errores).toEqual([])
  })

  it('detecta errores de AFIP y los expone con código y mensaje', () => {
    const parsed = parseCaeResponse(CAE_ERROR_XML)
    expect(parsed.ok).toBe(false)
    expect(parsed.resultado).toBe('R')
    expect(parsed.errores.length).toBe(1)
    expect(parsed.errores[0].code).toBe('10016')
    expect(parsed.errores[0].msg).toContain('punto de venta')
  })
})

describe('parseFeCompUltimoAutorizado (WSFEv1)', () => {
  it('extrae el último número autorizado', () => {
    const parsed = parseFeCompUltimoAutorizado(ULTIMO_AUTORIZADO_XML)
    expect(parsed.errores).toEqual([])
    expect(parsed.cbteNro).toBe(3)
  })

  it('sin emisiones previas devuelve cbteNro 0 (siguiente = 1)', () => {
    const parsed = parseFeCompUltimoAutorizado(
      '<FECompUltimoAutorizadoResult><PtoVta>1</PtoVta><CbteTipo>6</CbteTipo></FECompUltimoAutorizadoResult>'
    )
    expect(parsed.errores).toEqual([])
    expect(parsed.cbteNro).toBe(0)
  })
})
