import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

/**
 * Edge Function: ocr-google
 * Recibe un archivo en base64, llama a Google Document AI y retorna el texto crudo.
 * Req 6.8, 13.1 — credenciales leídas desde variables de entorno, nunca hardcodeadas.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { fileBase64, mimeType, fileName } = await req.json()

    if (!fileBase64) {
      return new Response(
        JSON.stringify({ error: 'fileBase64 es requerido' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Credenciales desde variables de entorno de Supabase (Req 13.1)
    const projectId  = Deno.env.get('GOOGLE_CLOUD_PROJECT_ID')
    const location   = Deno.env.get('GOOGLE_DOCUMENT_AI_LOCATION') ?? 'us'
    const processorId = Deno.env.get('GOOGLE_DOCUMENT_AI_PROCESSOR_ID')
    const apiKey     = Deno.env.get('GOOGLE_CLOUD_API_KEY')

    if (!projectId || !processorId || !apiKey) {
      return new Response(
        JSON.stringify({ error: 'Credenciales de Google Document AI no configuradas' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Llamar a Google Document AI API
    const endpoint = `https://documentai.googleapis.com/v1/projects/${projectId}/locations/${location}/processors/${processorId}:process?key=${apiKey}`

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawDocument: {
          content:  fileBase64,
          mimeType: mimeType ?? 'application/pdf',
        },
      }),
    })

    if (!response.ok) {
      const errBody = await response.text()
      throw new Error(`Google Document AI API error ${response.status}: ${errBody}`)
    }

    const docAiResult = await response.json()

    // Extraer texto del resultado
    const rawText = docAiResult?.document?.text ?? ''

    return new Response(
      JSON.stringify({
        rawText,
        rawResponse: {
          pages:      docAiResult?.document?.pages?.length ?? 0,
          confidence: docAiResult?.document?.textStyles?.[0]?.confidence ?? null,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('ocr-google error:', err)
    return new Response(
      JSON.stringify({ error: err.message ?? 'Error interno' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
