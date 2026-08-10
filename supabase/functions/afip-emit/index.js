import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import {
  getTokenAndSign,
  WSAA_URLS,
} from '../_shared/afipWsaa.js'
import {
  WSFEv1_URLS,
  getCbteTipo,
  mapInvoiceToCaeRequest,
  fecaeSolicitar,
  feDummy,
  feParamGetPtosVenta,
} from '../_shared/afipWsfe.js'

/**
 * Edge Function: afip-emit
 *
 * Emite comprobantes electrónicos contra WSFEv1 de ARCA (homologación por
 * defecto) y devuelve el CAE. El certificado y la clave privada viven acá
 * en el servidor — nunca llegan al browser.
 *
 * Variables de entorno requeridas:
 *   AFIP_CERT        — Certificado X.509 de homologación (PEM o base64 del PEM)
 *   AFIP_KEY         — Clave privada RSA 2048 (PEM o base64 del PEM)
 *   AFIP_CUIT        — CUIT (solo dígitos) que autorizó el certificado en WSASS
 *   AFIP_ENVIRONMENT — 'testing' (default) | 'production'
 *
 * Request body (JSON):
 *   action  {string}  — 'cae' (default) | 'dummy' | 'ptosVenta'
 *   invoice {object}  — datos del comprobante (solo para 'cae'):
 *       tipo_comprobante, punto_de_venta, numero_comprobante, fecha_emision,
 *       moneda, tipo_cambio, emisor_cuit, receptor_cuit, consumidor_final_anonimo,
 *       neto_gravado, neto_no_gravado, exento, iva_105, iva_21, iva_27,
 *       otros_tributos, total_amount, items[]
 *
 * Response body (JSON, acción 'cae'):
 *   ok, resultado, cae, caeVencimiento, errores, observaciones
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function readPemEnv(value) {
  if (!value) return null
  // Si el secreto ya viene como PEM lo usamos directo; si viene en base64 lo decodificamos.
  return value.includes('-----BEGIN') ? value : atob(value.replace(/\s+/g, ''))
}

function loadAfipConfig() {
  const cert = readPemEnv(Deno.env.get('AFIP_CERT'))
  const key = readPemEnv(Deno.env.get('AFIP_KEY'))
  const cuit = Deno.env.get('AFIP_CUIT')
  const environment = Deno.env.get('AFIP_ENVIRONMENT') ?? 'testing'

  if (!cert || !key || !cuit) {
    throw Object.assign(new Error(
      'Credenciales AFIP no configuradas. ' +
      'Configure AFIP_CERT, AFIP_KEY y AFIP_CUIT en las variables de entorno de Supabase.'
    ), { status: 503 })
  }
  return { cert, key, cuit: String(cuit).replace(/\D/g, ''), environment }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    let body
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Body inválido. Se esperaba JSON con action e invoice.' }, 400)
    }

    const { cert, key, cuit, environment } = loadAfipConfig()
    const wsaaUrl = WSAA_URLS[environment] ?? WSAA_URLS.testing
    const wsfeUrl = WSFEv1_URLS[environment] ?? WSFEv1_URLS.testing
    const action = body.action ?? 'cae'

    const { token, sign } = await getTokenAndSign({ privateKeyPem: key, certPem: cert, wsaaUrl })

    if (action === 'dummy') {
      const status = await feDummy({ wsfeUrl })
      return json({ ok: status.appServer === 'OK', status })
    }

    if (action === 'ptosVenta') {
      const result = await feParamGetPtosVenta({ wsfeUrl, token, sign, cuit })
      return json({ ok: result.errores.length === 0, ...result })
    }

    // ── Acción por defecto: emitir comprobante y obtener CAE ──────────────
    const invoice = body.invoice
    if (!invoice) {
      return json({ error: 'invoice es requerido para la acción "cae"' }, 400)
    }

    const cbteTipo = getCbteTipo(invoice.tipo_comprobante)
    const { cabecera, detalle } = mapInvoiceToCaeRequest({ invoice, cbteTipo })

    const result = await fecaeSolicitar({ wsfeUrl, token, sign, cuit, cabecera, detalle })

    if (result.errores.length > 0) {
      const msg = result.errores.map((e) => `[${e.code}] ${e.msg}`).join(' | ')
      return json({ ok: false, ...result, error: msg }, 422)
    }

    console.log(`afip-emit: ${invoice.tipo_comprobante} PtoVta=${cabecera.ptoVta} Nro=${detalle[0].cbteDesde} CAE=${result.cae} Resultado=${result.resultado}`)

    return json({ ok: result.ok, ...result })
  } catch (err) {
    const status = err.status ?? 500
    const message = err instanceof Error ? err.message : 'Error interno'
    console.error('afip-emit error:', message)
    return json({ error: message, ok: false }, status)
  }
})
