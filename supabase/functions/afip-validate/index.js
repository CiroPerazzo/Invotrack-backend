import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  getTokenAndSignCached,
  WSAA_URLS,
  extractTag,
} from '../_shared/afipWsaa.js'
import { createTokenStore } from '../_shared/supabaseTokenStore.js'
import { loadAfipConfig } from '../_shared/afipConfig.js'
import {
  WSFEv1_URLS,
  getCbteTipo,
  soapEnvelope,
  buildAuth,
  extractBlocks,
} from '../_shared/afipWsfe.js'

/**
 * Edge Function: afip-validate
 *
 * Valida un CAE contra WSFEv1 de ARCA usando FECompConsultar y actualiza el
 * campo `afip_status` de la factura correspondiente.
 *
 * Secretos requeridos (leídos por _shared/afipConfig.js):
 *   Arca.crt / Arca.key / Arca.CUIT   (nombres legacy: AFIP_CERT / AFIP_KEY / AFIP_CUIT)
 *   AFIP_ENVIRONMENT — 'production' | 'testing' (default: 'testing')
 *
 * Request body (JSON):
 *   cae          {string}  — Código de Autorización Electrónico (14 dígitos)
 *   caeVencimiento {string} — vencimiento del CAE (YYYY-MM-DD)
 *   cuit         {string}  — CUIT del emisor (con guiones o sin ellos)
 *   tipoComprobante {string} — nombre del tipo en InvoTrack (Factura A, etc.)
 *   puntoDeVenta {number}  — punto de venta del comprobante
 *   numeroComprobante {number} — número del comprobante
 *   invoiceId    {string}  — id de la factura para actualizar afip_status
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
      return json({ error: 'Body inválido. Se esperaba JSON con cae, caeVencimiento y cuit.' }, 400)
    }

    const { cae, caeVencimiento, cuit, invoiceId, tipoComprobante, puntoDeVenta, numeroComprobante } = body

    if (!cae || !caeVencimiento || !cuit) {
      return json({ error: 'cae, caeVencimiento y cuit son requeridos' }, 400)
    }

    const afip = loadAfipConfig()
    if (!afip?.cert || !afip?.key || !afip?.cuit) {
      return json({
        isValid: false,
        status: 'not_configured',
        message: 'Credenciales ARCA no configuradas. Revisá los secretos Arca.crt, Arca.key y Arca.CUIT.',
      })
    }

    const { cert, key, environment } = afip
    const wsaaUrl = WSAA_URLS[environment] ?? WSAA_URLS.testing
    const wsfeUrl = WSFEv1_URLS[environment] ?? WSFEv1_URLS.testing

    const { token, sign } = await getTokenAndSignCached({
      privateKeyPem: key,
      certPem: cert,
      wsaaUrl,
      cuit: afip.cuit,
      store: createTokenStore(),
    })

    let cbteTipo
    try {
      cbteTipo = /^\d+$/.test(String(tipoComprobante ?? ''))
        ? Number(tipoComprobante)
        : getCbteTipo(tipoComprobante)
    } catch {
      cbteTipo = 1
    }

    const soapBody = soapEnvelope('FECompConsultar', buildAuth({ token, sign, cuit: afip.cuit }) +
      '<FeCompConsReq>' +
      `<CbteTipo>${cbteTipo}</CbteTipo>` +
      `<PtoVta>${Number(puntoDeVenta) || 1}</PtoVta>` +
      `<CbteNro>${Number(numeroComprobante) || 1}</CbteNro>` +
      '</FeCompConsReq>')

    let afipStatus = 'unknown'
    let isValid = false
    let message = 'No se pudo validar el CAE'

    try {
      const afipResponse = await fetch(wsfeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': 'http://ar.gov.afip.dif.FEV1/FECompConsultar',
        },
        body: soapBody,
      })

      if (afipResponse.ok) {
        const responseText = await afipResponse.text()
        const errores = extractBlocks(responseText, 'Err')
        const resultado = extractTag(responseText, 'Resultado')

        if (errores.length > 0) {
          const primerError = errores[0]
          afipStatus = 'not_found'
          message = `${extractTag(primerError, 'Code') ?? ''} ${extractTag(primerError, 'Msg') ?? ''}`.trim()
        } else if (responseText.includes(cae)) {
          isValid = true
          afipStatus = 'valid'
          message = `CAE válido según AFIP (${resultado ?? 'A'})`
        } else {
          afipStatus = 'not_found'
          message = 'El CAE no coincide con el comprobante consultado'
        }
      } else {
        afipStatus = 'api_error'
        message = `Error al consultar AFIP: HTTP ${afipResponse.status}`
      }
    } catch (fetchErr) {
      afipStatus = 'connection_error'
      message = `No se pudo conectar con AFIP: ${fetchErr instanceof Error ? fetchErr.message : 'Error desconocido'}`
    }

    if (invoiceId) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
      if (supabaseUrl && serviceKey) {
        const supabase = createClient(supabaseUrl, serviceKey)
        await supabase
          .from('invoices')
          .update({ afip_status: afipStatus })
          .eq('id', invoiceId)
      }
    }

    return json({ isValid, status: afipStatus, message })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error interno'
    console.error('afip-validate error:', message)
    return json({ error: message }, 500)
  }
})
