import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import {
  getTokenAndSignCached,
  WSAA_URLS,
} from '../_shared/afipWsaa.js'
import { createTokenStore } from '../_shared/supabaseTokenStore.js'
import { loadAfipConfig, diagnoseConfig } from '../_shared/afipConfig.js'
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
 * Secretos requeridos (leídos por _shared/afipConfig.js):
 *   Arca.crt / Arca.key / Arca.CUIT   (nombres legacy: AFIP_CERT / AFIP_KEY / AFIP_CUIT)
 *   AFIP_ENVIRONMENT — 'testing' (default) | 'production'
 *
 * Request body (JSON):
 *   action  {string}  — 'cae' (default) | 'dummy' | 'ptosVenta' | 'diagnose'
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

    const action = body.action ?? 'cae'

    if (action === 'diagnose') {
      const diag = diagnoseConfig()
      return json({ ok: true, ...diag })
    }

    const cfg = loadAfipConfig()
    if (!cfg.cert || !cfg.key || !cfg.cuit) {
      throw Object.assign(new Error(
        'Credenciales ARCA no configuradas. Revisá los secretos Arca.crt, Arca.key y Arca.CUIT (action=diagnose para detalle).'
      ), { status: 503 })
    }
    const { cert, key, cuit, environment } = cfg
    const wsaaUrl = WSAA_URLS[environment] ?? WSAA_URLS.testing
    const wsfeUrl = WSFEv1_URLS[environment] ?? WSFEv1_URLS.testing

    const { token, sign } = await getTokenAndSignCached({
      privateKeyPem: key,
      certPem: cert,
      wsaaUrl,
      cuit,
      store: createTokenStore(),
    })

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
