import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * Edge Function: afip-validate
 *
 * Valida un CAE contra la API de AFIP y actualiza el campo `afip_status`
 * en la factura correspondiente.
 *
 * Variables de entorno requeridas:
 *   AFIP_CERT        — Certificado X.509 en PEM (base64)
 *   AFIP_KEY         — Clave privada en PEM (base64)
 *   AFIP_CUIT        — CUIT del contribuyente que consulta
 *   AFIP_ENVIRONMENT — 'production' | 'testing' (default: 'testing')
 *
 * Requirements: 15.4, 13.1
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    let body: { cae?: string; caeVencimiento?: string; cuit?: string; invoiceId?: string }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Body inválido. Se esperaba JSON con cae, caeVencimiento y cuit.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { cae, caeVencimiento, cuit, invoiceId } = body

    if (!cae || !caeVencimiento || !cuit) {
      return new Response(
        JSON.stringify({ error: 'cae, caeVencimiento y cuit son requeridos' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Credenciales AFIP desde variables de entorno (Req 13.1)
    const afipCert        = Deno.env.get('AFIP_CERT')
    const afipKey         = Deno.env.get('AFIP_KEY')
    const afipCuit        = Deno.env.get('AFIP_CUIT')
    const afipEnvironment = Deno.env.get('AFIP_ENVIRONMENT') ?? 'testing'

    if (!afipCert || !afipKey || !afipCuit) {
      // Sin credenciales, retornar estado "not_configured" sin bloquear
      return new Response(
        JSON.stringify({
          isValid: false,
          status: 'not_configured',
          message: 'Credenciales AFIP no configuradas. Configure AFIP_CERT, AFIP_KEY y AFIP_CUIT en las variables de entorno de Supabase.',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Endpoint AFIP según entorno
    const wsfeEndpoint = afipEnvironment === 'production'
      ? 'https://servicios1.afip.gov.ar/wsfev1/service.asmx'
      : 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx'

    // Llamada SOAP a AFIP para consultar CAE
    // FECompConsultar — consulta un comprobante por CAE
    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <FECompConsultar xmlns="http://ar.gov.afip.dif.FEV1/">
      <Auth>
        <Cuit>${afipCuit}</Cuit>
      </Auth>
      <FeCompConsReq>
        <CbteTipo>1</CbteTipo>
        <PtoVta>1</PtoVta>
        <CbteNro>1</CbteNro>
      </FeCompConsReq>
    </FECompConsultar>
  </soap:Body>
</soap:Envelope>`

    let afipStatus = 'unknown'
    let isValid = false
    let message = 'No se pudo validar el CAE'

    try {
      const afipResponse = await fetch(wsfeEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': 'http://ar.gov.afip.dif.FEV1/FECompConsultar',
        },
        body: soapBody,
      })

      if (afipResponse.ok) {
        const responseText = await afipResponse.text()
        // Verificar si el CAE aparece en la respuesta
        if (responseText.includes(cae)) {
          isValid = true
          afipStatus = 'valid'
          message = 'CAE válido según AFIP'
        } else {
          afipStatus = 'not_found'
          message = 'CAE no encontrado en AFIP'
        }
      } else {
        afipStatus = 'api_error'
        message = `Error al consultar AFIP: HTTP ${afipResponse.status}`
      }
    } catch (fetchErr) {
      afipStatus = 'connection_error'
      message = `No se pudo conectar con AFIP: ${fetchErr instanceof Error ? fetchErr.message : 'Error desconocido'}`
    }

    // Actualizar afip_status en la factura si se proporcionó invoiceId
    if (invoiceId) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')
      const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
      if (supabaseUrl && serviceKey) {
        const supabase = createClient(supabaseUrl, serviceKey)
        await supabase
          .from('invoices')
          .update({ afip_status: afipStatus })
          .eq('id', invoiceId)
      }
    }

    return new Response(
      JSON.stringify({ isValid, status: afipStatus, message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error interno'
    console.error('afip-validate error:', message)
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
