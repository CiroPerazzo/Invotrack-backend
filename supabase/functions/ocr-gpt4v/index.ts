import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'

/**
 * Edge Function: ocr-gpt4v
 *
 * Recibe una imagen de factura en base64 y usa GPT-4 Vision para extraer
 * todos los datos del comprobante fiscal argentino.
 *
 * La API key de OpenAI vive acá en el servidor — nunca llega al browser.
 *
 * Variable de entorno requerida:
 *   OPENAI_API_KEY — tu API key de OpenAI (sk-...)
 *
 * Request body (JSON):
 *   fileBase64  {string}  — imagen en base64
 *   mimeType    {string}  — 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf'
 *
 * Response body (JSON):
 *   rawText     {string}  — texto estructurado extraído por GPT-4
 *   rawResponse {object}  — respuesta completa de OpenAI
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const EXTRACTION_PROMPT = `Sos un sistema de extracción de datos de facturas argentinas. 
Analizá la imagen y extraé TODOS los datos del comprobante fiscal en el siguiente formato exacto:

TIPO: [Factura A / Factura B / Factura C / Nota de Crédito A / etc]
NUMERO: [XXXX-XXXXXXXX]
FECHA_EMISION: [DD/MM/YYYY]
FECHA_VENCIMIENTO: [DD/MM/YYYY o vacío]
CAE: [14 dígitos o vacío]
VENC_CAE: [DD/MM/YYYY o vacío]
CONDICION_PAGO: [contado / cuenta corriente]

VENDEDOR:
RAZON_SOCIAL: [nombre]
CUIT: [XX-XXXXXXXX-X]
CONDICION_IVA: [RI / MO / EX / CF / RS]
DOMICILIO: [dirección]

COMPRADOR:
RAZON_SOCIAL: [nombre]
CUIT: [XX-XXXXXXXX-X]
CONDICION_IVA: [RI / MO / EX / CF / RS]
DOMICILIO: [dirección]

ITEMS:
- DESCRIPCION: [texto] | CANTIDAD: [número] | PRECIO_UNITARIO: [número] | ALICUOTA_IVA: [0/10.5/21/27] | SUBTOTAL_NETO: [número]
(repetir para cada ítem)

NETO_GRAVADO: [número]
IVA_105: [número o 0]
IVA_21: [número o 0]
IVA_27: [número o 0]
TOTAL: [número]

Si un campo no está visible o no existe, dejalo vacío. No inventes datos. Usá punto como separador decimal.`

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const openaiKey = Deno.env.get('OPENAI_API_KEY')

    if (!openaiKey) {
      return new Response(
        JSON.stringify({ error: 'OPENAI_API_KEY no configurada en las variables de entorno de Supabase' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let body: { fileBase64?: string; mimeType?: string }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Body inválido. Se esperaba JSON con fileBase64 y mimeType.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { fileBase64, mimeType = 'image/jpeg' } = body

    if (!fileBase64) {
      return new Response(
        JSON.stringify({ error: 'fileBase64 es requerido' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Para PDFs, GPT-4 Vision no los soporta directamente
    // Los tratamos como imagen (el frontend debería convertir la primera página)
    const imageUrl = `data:${mimeType};base64,${fileBase64}`

    console.log(`ocr-gpt4v: procesando imagen, mimeType=${mimeType}`)

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',  // gpt-4o tiene mejor soporte de visión que gpt-4-vision-preview
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: EXTRACTION_PROMPT,
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageUrl,
                  detail: 'high',  // alta resolución para mejor extracción
                },
              },
            ],
          },
        ],
      }),
    })

    if (!openaiResponse.ok) {
      const errBody = await openaiResponse.text()
      console.error(`ocr-gpt4v: OpenAI API error ${openaiResponse.status}:`, errBody)
      throw new Error(`OpenAI API error ${openaiResponse.status}: ${errBody}`)
    }

    const openaiResult = await openaiResponse.json()
    const rawText = openaiResult.choices?.[0]?.message?.content ?? ''

    console.log(`ocr-gpt4v: extracción completada. Tokens usados: ${openaiResult.usage?.total_tokens ?? 'N/A'}`)

    return new Response(
      JSON.stringify({
        rawText,
        rawResponse: {
          model: openaiResult.model,
          usage: openaiResult.usage,
          finish_reason: openaiResult.choices?.[0]?.finish_reason,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error interno'
    console.error('ocr-gpt4v error:', message)
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
