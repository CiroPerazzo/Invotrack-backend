import { describe, it, expect, vi } from 'vitest'
import {
  hashDatosFactura,
  procesarRespuestaCae,
  emitirCaeIdempotente,
} from '../../../../scripts/arca/wsfe-client.js'
import {
  esCuitValido,
  esFechaAfip,
  validarImportes,
  validarDatosFactura,
  parseArgs,
  camposFaltantes,
} from '../../../../scripts/arca/cae-utils.js'

const BASE_DATOS = {
  ptoVta: 1,
  cbteTipo: 1,
  concepto: 1,
  docTipo: 80,
  docNro: 20111111112,
  cbteFch: '20260809',
  impTotal: 12100,
  impNeto: 10000,
  impIva: 2100,
  impOpEx: 0,
  impTotConc: 0,
  impTrib: 0,
  monId: 'PES',
  monCotiz: 1,
  iva: [{ id: 5, baseImp: 10000, importe: 2100 }],
}

const catalogoValido = {
  ptosVenta: [{ nro: 1, emisionTipo: 'CAE', bloqueado: false }],
  tiposCbte: [{ id: 1, desc: 'Factura A' }],
  tiposDoc: [{ id: 80, desc: 'CUIT' }],
  tiposIva: [{ id: 5, desc: '21%' }],
  monedas: [{ id: 'PES', desc: 'Pesos' }],
}

// ── hashDatosFactura ────────────────────────────────────────────────────────

describe('hashDatosFactura (idempotencia)', () => {
  it('es estable y no depende del número de comprobante', () => {
    const a = hashDatosFactura(BASE_DATOS)
    const b = hashDatosFactura({ ...BASE_DATOS, cbteNro: 9999 })
    expect(a).toBe(b)
  })

  it('cambia si cambia un dato comercial (importe, receptor, fecha)', () => {
    const base = hashDatosFactura(BASE_DATOS)
    expect(hashDatosFactura({ ...BASE_DATOS, impTotal: 13000 })).not.toBe(base)
    expect(hashDatosFactura({ ...BASE_DATOS, docNro: 20222222221 })).not.toBe(base)
    expect(hashDatosFactura({ ...BASE_DATOS, cbteFch: '20260810' })).not.toBe(base)
  })

  it('cambia si cambia punto de venta o tipo de comprobante', () => {
    const base = hashDatosFactura(BASE_DATOS)
    expect(hashDatosFactura({ ...BASE_DATOS, ptoVta: 2 })).not.toBe(base)
    expect(hashDatosFactura({ ...BASE_DATOS, cbteTipo: 6 })).not.toBe(base)
  })
})

// ── procesarRespuestaCae ────────────────────────────────────────────────────

describe('procesarRespuestaCae', () => {
  it('mapea respuesta A a estado AUTORIZADO con CAE', () => {
    const r = procesarRespuestaCae({
      ok: true,
      ptoVta: 1,
      cbteTipo: 1,
      cbteNro: 42,
      resultadoCabecera: 'A',
      cae: '70000000000001',
      caeVencimiento: '20260820',
      comprobante: { cbteFch: '20260809', resultado: 'A' },
      errores: [],
      observaciones: [{ code: 0, msg: 'sin novedad' }],
    })
    expect(r.estado).toBe('AUTORIZADO')
    expect(r.cae).toBe('70000000000001')
    expect(r.numero).toBe(42)
  })

  it('no confía en el HTTP: errores ARCA → RECHAZADO', () => {
    const r = procesarRespuestaCae({
      ok: false,
      ptoVta: 1,
      cbteTipo: 1,
      cbteNro: 42,
      resultadoCabecera: 'R',
      cae: null,
      caeVencimiento: null,
      comprobante: null,
      errores: [{ code: 10016, msg: 'Error' }],
      observaciones: [],
    })
    expect(r.estado).toBe('RECHAZADO')
    expect(r.cae).toBeNull()
  })

  it('respuesta sin confirmar → VERIFICAR_ARCA', () => {
    const r = procesarRespuestaCae({
      ok: false,
      ptoVta: 1,
      cbteTipo: 1,
      cbteNro: 42,
      resultadoCabecera: 'P',
      cae: null,
      caeVencimiento: null,
      comprobante: null,
      errores: [],
      observaciones: [],
    })
    expect(r.estado).toBe('VERIFICAR_ARCA')
  })
})

// ── Validación de CUIT y fechas ─────────────────────────────────────────────

describe('esCuitValido', () => {
  it('acepta CUITs válidos', () => {
    expect(esCuitValido('20111111112')).toBe(true)
    expect(esCuitValido('20222222223')).toBe(true)
    expect(esCuitValido('23169967679')).toBe(true)
    expect(esCuitValido('30500010912')).toBe(true)
  })

  it('rechaza CUITs inválidos', () => {
    expect(esCuitValido('20111111111')).toBe(false)
    expect(esCuitValido('99999999999')).toBe(false)
    expect(esCuitValido('123')).toBe(false)
    expect(esCuitValido('abcdefghijk')).toBe(false)
  })
})

describe('esFechaAfip', () => {
  it('valida el formato YYYYMMDD', () => {
    expect(esFechaAfip('20260809')).toBe(true)
    expect(esFechaAfip('2026-08-09')).toBe(false)
    expect(esFechaAfip(undefined)).toBe(false)
  })
})

// ── Consistencia de importes ────────────────────────────────────────────────

describe('validarImportes', () => {
  it('total = neto + iva + exento + no gravado + tributos', () => {
    expect(validarImportes(BASE_DATOS)).toEqual([])
    expect(validarImportes({
      ...BASE_DATOS,
      impTotal: 12100,
      impNeto: 10000,
      impIva: 2100,
      impOpEx: 0,
      impTotConc: 0,
      impTrib: 0,
    })).toEqual([])
  })

  it('detecta importes inconsistentes', () => {
    const errs = validarImportes({ ...BASE_DATOS, impTotal: 99999 })
    expect(errs.some((e) => /inconsistentes/i.test(e))).toBe(true)
  })

  it('detecta impIva que no coincide con las alícuotas', () => {
    const errs = validarImportes({ ...BASE_DATOS, impIva: 999 })
    expect(errs.some((e) => /impIva/i.test(e))).toBe(true)
  })
})

// ── validarDatosFactura contra catálogos ARCA ───────────────────────────────

describe('validarDatosFactura', () => {
  it('acepta datos válidos contra el catálogo', () => {
    const { ok, errores } = validarDatosFactura(BASE_DATOS, catalogoValido)
    expect(errores).toEqual([])
    expect(ok).toBe(true)
  })

  it('rechaza punto de venta inexistente o bloqueado', () => {
    expect(validarDatosFactura(BASE_DATOS, catalogoValido).ok).toBe(true)
    expect(validarDatosFactura({ ...BASE_DATOS, ptoVta: 9 }, catalogoValido).errores.some((e) => /punto de venta 9/i.test(e))).toBe(true)
    expect(validarDatosFactura(BASE_DATOS, {
      ...catalogoValido,
      ptosVenta: [{ nro: 1, emisionTipo: 'CAE', bloqueado: true }],
    }).errores.some((e) => /bloqueado/i.test(e))).toBe(true)
  })

  it('rechaza tipo de comprobante y documento inexistentes', () => {
    expect(validarDatosFactura({ ...BASE_DATOS, cbteTipo: 99 }, catalogoValido).errores.some((e) => /comprobante 99/i.test(e))).toBe(true)
    expect(validarDatosFactura({ ...BASE_DATOS, docTipo: 96 }, catalogoValido).errores.some((e) => /documento 96/i.test(e))).toBe(true)
  })

  it('rechaza CUIT de receptor inválido', () => {
    const { errores } = validarDatosFactura({ ...BASE_DATOS, docNro: 20111111111 }, catalogoValido)
    expect(errores.some((e) => /CUIT válido/i.test(e))).toBe(true)
  })

  it('no valida contra nada si faltan los catálogos (ARCA no disponible)', () => {
    const { ok } = validarDatosFactura(BASE_DATOS, null)
    expect(ok).toBe(false)
  })
})

// ── parseArgs y camposFaltantes ─────────────────────────────────────────────

describe('parseArgs', () => {
  it('parsea --clave valor y --clave=valor', () => {
    const args = parseArgs(['node', 'x', '--ptoVta', '1', '--cbteTipo=6', '--docNro', '20111111112'])
    expect(args.ptoVta).toBe(1)
    expect(args.cbteTipo).toBe(6)
    expect(args.docNro).toBe(20111111112)
  })

  it('convierte a número las claves numéricas', () => {
    const args = parseArgs(['--impTotal', '12100.50', '--iva21', '10000'])
    expect(args.impTotal).toBe(12100.5)
    expect(args.iva21).toBe(10000)
  })
})

describe('camposFaltantes', () => {
  it('lista los campos requeridos ausentes', () => {
    const faltantes = camposFaltantes({ ptoVta: 1 })
    expect(faltantes).toContain('tipo de comprobante (--cbteTipo, ej: 1)')
    expect(faltantes).toContain('importe neto gravado (--impNeto)')
  })
})

// ── Idempotencia de emisión (sin red, deps inyectadas) ──────────────────────

describe('emitirCaeIdempotente', () => {
  const auth = { token: 't', sign: 's', cuit: '23169967679' }

  const respuestaOk = {
    ok: true,
    ptoVta: 1,
    cbteTipo: 1,
    cbteNro: 100,
    resultadoCabecera: 'A',
    cae: '70000000000001',
    caeVencimiento: '20260820',
    comprobante: { cbteDesde: 100, cbteHasta: 100, cbteFch: '20260809', resultado: 'A' },
    errores: [],
    observaciones: [],
  }

  function storeInMemory() {
    let map = {}
    return {
      cargarIntento: ({ ptoVta, cbteTipo }) => map[`${ptoVta}:${cbteTipo}`] ?? null,
      guardarIntento: (i) => { map[`${i.ptoVta}:${i.cbteTipo}`] = i },
      ultimoEstado: () => map,
    }
  }

  it('primer intento: consulta el número siguiente y emite', async () => {
    const store = storeInMemory()
    const ultimoAutorizado = vi.fn(async () => ({ cbteNro: 99 }))
    const enviarCAE = vi.fn(async (a, d) => ({ ...respuestaOk, cbteNro: d.cbteNro }))
    const consultarCAEExistente = vi.fn(async () => null)

    const r = await emitirCaeIdempotente(auth, BASE_DATOS, {
      cargarIntento: store.cargarIntento,
      guardarIntento: store.guardarIntento,
      ultimoAutorizado,
      enviarCAE,
      consultarCAEExistente,
    })

    expect(ultimoAutorizado).toHaveBeenCalledWith(auth, { ptoVta: 1, cbteTipo: 1 })
    expect(enviarCAE).toHaveBeenCalledTimes(1)
    expect(enviarCAE.mock.calls[0][1].cbteNro).toBe(100)
    expect(r.ok).toBe(true)
    expect(store.ultimoEstado()['1:1'].estado).toBe('AUTORIZADO')
  })

  it('NO emite duplicado si ya fue autorizado: recupera con FECompConsultar', async () => {
    const store = storeInMemory()
    const intento = {
      ptoVta: 1, cbteTipo: 1, cbteNro: 100,
      hash: hashDatosFactura(BASE_DATOS),
      estado: 'PENDIENTE_ARCA',
    }
    store.guardarIntento(intento)

    const enviarCAE = vi.fn(async () => respuestaOk)
    const consultarCAEExistente = vi.fn(async () => ({
      cbteNro: 100, cbteTipo: 1, ptoVta: 1,
      resultado: 'A', cbteFch: '20260809',
      cae: '70000000000001', caeFchVto: '20260820',
    }))

    const r = await emitirCaeIdempotente(auth, BASE_DATOS, {
      cargarIntento: store.cargarIntento,
      guardarIntento: store.guardarIntento,
      enviarCAE,
      consultarCAEExistente,
    })

    expect(r.recuperado).toBe(true)
    expect(r.cae).toBe('70000000000001')
    expect(enviarCAE).not.toHaveBeenCalled()
  })

  it('si ARCA no tiene el comprobante, reintenta con el MISMO número', async () => {
    const store = storeInMemory()
    store.guardarIntento({
      ptoVta: 1, cbteTipo: 1, cbteNro: 100,
      hash: hashDatosFactura(BASE_DATOS),
      estado: 'PENDIENTE_ARCA',
    })

    const enviarCAE = vi.fn(async (a, d) => ({ ...respuestaOk, cbteNro: d.cbteNro }))
    const consultarCAEExistente = vi.fn(async () => null)

    const r = await emitirCaeIdempotente(auth, BASE_DATOS, {
      cargarIntento: store.cargarIntento,
      guardarIntento: store.guardarIntento,
      enviarCAE,
      consultarCAEExistente,
    })

    expect(consultarCAEExistente).toHaveBeenCalledWith(auth, { ptoVta: 1, cbteTipo: 1, cbteNro: 100 })
    expect(enviarCAE).toHaveBeenCalledTimes(1)
    expect(enviarCAE.mock.calls[0][1].cbteNro).toBe(100)
    expect(r.cbteNro).toBe(100)
  })

  it('si la verificación falla (corte de red), aborta y deja el intento pendiente', async () => {
    const store = storeInMemory()
    store.guardarIntento({
      ptoVta: 1, cbteTipo: 1, cbteNro: 100,
      hash: hashDatosFactura(BASE_DATOS),
      estado: 'PENDIENTE_ARCA',
    })

    const consultarCAEExistente = vi.fn(async () => { throw new Error('network down') })
    const enviarCAE = vi.fn()

    await expect(
      emitirCaeIdempotente(auth, BASE_DATOS, {
        cargarIntento: store.cargarIntento,
        guardarIntento: store.guardarIntento,
        enviarCAE,
        consultarCAEExistente,
      })
    ).rejects.toThrow(/No se pudo verificar/)
    expect(enviarCAE).not.toHaveBeenCalled()
    expect(store.ultimoEstado()['1:1'].estado).toBe('PENDIENTE_ARCA')
  })

  it('bloquea si el intento pendiente corresponde a OTROS datos', async () => {
    const store = storeInMemory()
    store.guardarIntento({
      ptoVta: 1, cbteTipo: 1, cbteNro: 100,
      hash: 'otro-hash',
      estado: 'PENDIENTE_ARCA',
    })
    const enviarCAE = vi.fn()

    await expect(
      emitirCaeIdempotente(auth, { ...BASE_DATOS, impTotal: 99999 }, {
        cargarIntento: store.cargarIntento,
        guardarIntento: store.guardarIntento,
        enviarCAE,
      })
    ).rejects.toThrow(/OTROS datos/)
    expect(enviarCAE).not.toHaveBeenCalled()
  })
})
