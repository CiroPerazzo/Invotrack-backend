import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'
import {
  buildLoginTicketRequest,
  canonicalSignedInfo,
  formatBuenosAiresTime,
  signLoginTicketRequest,
  toPkcs8Der,
  base64ToBytes,
  bytesToBase64,
  isTokenValid,
  parseCuitFromCert,
  getTokenAndSignCached,
} from '../../../../supabase/functions/_shared/afipWsaa.js'

const encoder = new TextEncoder()

function sha1Base64(text) {
  return crypto.subtle.digest('SHA-1', encoder.encode(text)).then((d) => bytesToBase64(new Uint8Array(d)))
}

function pemOf(bytes, label) {
  const b64 = bytesToBase64(bytes).match(/.{1,64}/g).join('\n')
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`
}

// ── formatBuenosAiresTime ──────────────────────────────────────────────────

describe('formatBuenosAiresTime (WSAA)', () => {
  it('devuelve el formato YYYY-MM-DDTHH:mm:ss-03:00 para cualquier fecha', () => {
    fc.assert(
      fc.property(
        // Timestamps entre 2000 y 2100 (años de 4 dígitos, como exige ARCA)
        fc.integer({ min: 946684800000, max: 4102444800000 }).map((ms) => new Date(ms)),
        (date) => {
          const out = formatBuenosAiresTime(date)
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-03:00$/.test(out)) return false
          // El parseo del string (con offset -03:00) debe devolver el mismo instante (±1s)
          const roundtrip = new Date(out).getTime()
          return Math.abs(roundtrip - date.getTime()) < 1000
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ── buildLoginTicketRequest ────────────────────────────────────────────────

describe('buildLoginTicketRequest (WSAA)', () => {
  it('construye el XML con uniqueId, tiempos y servicio', () => {
    const xml = buildLoginTicketRequest({
      uniqueId: 123456,
      generationTime: '2024-01-01T10:00:00-03:00',
      expirationTime: '2024-01-01T12:00:00-03:00',
      service: 'wsfe',
    })
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('<uniqueId>123456</uniqueId>')
    expect(xml).toContain('<generationTime>2024-01-01T10:00:00-03:00</generationTime>')
    expect(xml).toContain('<service>wsfe</service>')
    expect(xml).toContain('</loginTicketRequest>')
  })
})

// ── Conversión PKCS#1 → PKCS#8 ─────────────────────────────────────────────

describe('toPkcs8Der (WSAA)', () => {
  it('convierte PKCS#1 (BEGIN RSA PRIVATE KEY) a DER PKCS#8 importable por WebCrypto', async () => {
    const { privateKey } = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1' },
      true,
      ['sign', 'verify']
    )
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey)
    const pkcs8Pem = pemOf(new Uint8Array(pkcs8), 'PRIVATE KEY')

    const der = toPkcs8Der(pkcs8Pem)
    // Re-importar debe funcionar sin errores
    await expect(
      crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' }, false, ['sign'])
    ).resolves.toBeDefined()
  })

  it('lanza si el PEM no tiene un bloque válido', () => {
    expect(() => toPkcs8Der('no soy un pem')).toThrow(/no se encontró un bloque PEM/i)
  })
})

// ── Firma completa del LoginTicketRequest ──────────────────────────────────

describe('signLoginTicketRequest (WSAA)', () => {
  it('produce un CMT cuyo digest y firma se verifican de forma autoconsistente', async () => {
    const { privateKey, publicKey } = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1' },
      true,
      ['sign', 'verify']
    )
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey)
    const spki = await crypto.subtle.exportKey('spki', publicKey)
    const privatePem = pemOf(new Uint8Array(pkcs8), 'PRIVATE KEY')

    const unsigned = buildLoginTicketRequest({
      uniqueId: 424242,
      generationTime: '2024-01-01T10:00:00-03:00',
      expirationTime: '2024-01-01T22:00:00-03:00',
      service: 'wsfe',
    })

    // Usamos el SPKI como "certificado" solo para validar el pipeline de firma
    const certBody = bytesToBase64(new Uint8Array(spki))
    const signed = await signLoginTicketRequest(unsigned, { privateKeyPem: privatePem, certPem: certBody })

    expect(signed).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(signed).toContain('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">')
    expect(signed).toContain(`<X509Certificate>${certBody}</X509Certificate>`)
    expect(signed).not.toContain('<Signature' + '><SignedInfo></SignedInfo>')

    // 1) El DigestValue debe ser sha1 del <loginTicketRequest> sin la firma
    const element = unsigned.replace(/^<\?xml[^>]*\?>/i, '').trim()
    const digestExpected = await sha1Base64(element)
    const digestMatch = signed.match(/<DigestValue>([^<]+)<\/DigestValue>/)
    expect(digestMatch).not.toBeNull()
    expect(digestMatch[1]).toBe(digestExpected)

    // 2) La firma debe verificar contra la clave pública sobre la forma
    //    canónica del SignedInfo (canonicalSignedInfo re-genera esa forma).
    const sigMatch = signed.match(/<SignatureValue>([^<]+)<\/SignatureValue>/)
    expect(sigMatch).not.toBeNull()

    const canonical = canonicalSignedInfo(digestExpected)
    const verified = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      publicKey,
      base64ToBytes(sigMatch[1]),
      encoder.encode(canonical)
    )
    expect(verified).toBe(true)
  })
})

// ── isTokenValid ────────────────────────────────────────────────────────────

describe('isTokenValid (TA compartido)', () => {
  it('acepta un vencimiento futuro holgado', () => {
    const futuro = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    expect(isTokenValid(futuro)).toBe(true)
  })

  it('rechaza vencidos y vencimientos dentro del margen de seguridad', () => {
    const vencido = new Date(Date.now() - 1000).toISOString()
    expect(isTokenValid(vencido)).toBe(false)
    const muyCerca = new Date(Date.now() + 60 * 1000).toISOString()
    expect(isTokenValid(muyCerca)).toBe(false)
  })

  it('rechaza valores ausentes o inválidos', () => {
    expect(isTokenValid(null)).toBe(false)
    expect(isTokenValid(undefined)).toBe(false)
    expect(isTokenValid('')).toBe(false)
    expect(isTokenValid('no-es-fecha')).toBe(false)
  })

  it('es consistente: el mismo instante siempre da el mismo resultado', () => {
    fc.assert(
      fc.property(
        fc.constant(new Date(Date.now() + 30 * 60 * 1000).toISOString()),
        (iso) => {
          const a = isTokenValid(iso)
          const b = isTokenValid(iso)
          return a === b
        }
      )
    )
  })
})

// ── parseCuitFromCert ───────────────────────────────────────────────────────

describe('parseCuitFromCert (fallback de CUIT)', () => {
  it('extrae el CUIT de CN=cuit:XXXXXXXXXXX', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nsubject=CN=cuit:20305741461, name=Empresa SA\n-----END CERTIFICATE-----'
    expect(parseCuitFromCert(pem)).toBe('20305741461')
  })

  it('extrae el CUIT de CN directo y de serialNumber', () => {
    expect(parseCuitFromCert('CN=20305741461')).toBe('20305741461')
    expect(parseCuitFromCert('serialNumber=CUIT 20305741461')).toBe('20305741461')
    expect(parseCuitFromCert('serialNumber=20305741461')).toBe('20305741461')
  })

  it('devuelve null si no hay CUIT', () => {
    expect(parseCuitFromCert(null)).toBeNull()
    expect(parseCuitFromCert('')).toBeNull()
    expect(parseCuitFromCert('CN=Algo sin numero')).toBeNull()
  })
})

// ── getTokenAndSignCached ───────────────────────────────────────────────────

describe('getTokenAndSignCached (TA compartido)', () => {
  const base = {
    privateKeyPem: 'k',
    certPem: 'c',
    wsaaUrl: 'https://wsaahomo.afip.gov.ar',
    cuit: '20305741461',
  }
  const tokenFresco = {
    token: 'tok-1',
    sign: 'sig-1',
    expirationTime: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
  }

  function storeCon(initial = null) {
    let guardado = initial
    return {
      store: {
        loadToken: vi.fn(async () => guardado),
        saveToken: vi.fn(async (t) => { guardado = t }),
      },
      ultimoGuardado: () => guardado,
    }
  }

  it('reutiliza el TA vigente sin llamar a WSAA', async () => {
    const { store } = storeCon(tokenFresco)
    const requestToken = vi.fn()

    const r = await getTokenAndSignCached({ ...base, store, requestToken })

    expect(r.reused).toBe(true)
    expect(r.token).toBe('tok-1')
    expect(requestToken).not.toHaveBeenCalled()
    expect(store.saveToken).not.toHaveBeenCalled()
  })

  it('pide TA nuevo si no hay caché y lo persiste', async () => {
    const { store, ultimoGuardado } = storeCon(null)
    const requestToken = vi.fn(async () => tokenFresco)

    const r = await getTokenAndSignCached({ ...base, store, requestToken })

    expect(r.reused).toBe(false)
    expect(requestToken).toHaveBeenCalledWith(expect.objectContaining({ service: 'wsfe', wsaaUrl: base.wsaaUrl }))
    expect(store.saveToken).toHaveBeenCalledWith(expect.objectContaining({ service: 'wsfe', cuit: base.cuit }))
    expect(ultimoGuardado().token).toBe('tok-1')
  })

  it('pide TA nuevo si la caché está vencida', async () => {
    const vencido = { ...tokenFresco, expirationTime: new Date(Date.now() - 1000).toISOString() }
    const { store, ultimoGuardado } = storeCon(vencido)
    const requestToken = vi.fn(async () => ({ ...tokenFresco, token: 'tok-2' }))

    const r = await getTokenAndSignCached({ ...base, store, requestToken })

    expect(r.reused).toBe(false)
    expect(r.token).toBe('tok-2')
    expect(ultimoGuardado().token).toBe('tok-2')
  })

  it('recupera de la caché si WSAA responde alreadyAuthenticated', async () => {
    const { store, ultimoGuardado } = storeCon(tokenFresco)
    const requestToken = vi.fn(async () => { throw new Error('coe.alreadyAuthenticated') })

    const r = await getTokenAndSignCached({ ...base, store, requestToken })

    expect(r.reused).toBe(true)
    expect(r.token).toBe('tok-1')
    expect(store.saveToken).not.toHaveBeenCalled()
    expect(ultimoGuardado().token).toBe('tok-1')
  })

  it('propaga el error si alreadyAuthenticated y no hay caché utilizable', async () => {
    const { store } = storeCon(null)
    const requestToken = vi.fn(async () => { throw new Error('coe.alreadyAuthenticated') })

    await expect(getTokenAndSignCached({ ...base, store, requestToken })).rejects.toThrow(/alreadyAuthenticated/)
  })

  it('valida store y cuit obligatorios', async () => {
    await expect(getTokenAndSignCached({ ...base, store: null })).rejects.toThrow(/store/)
    const { store } = storeCon(tokenFresco)
    await expect(getTokenAndSignCached({ ...base, store, cuit: null })).rejects.toThrow(/cuit/)
  })
})
