import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'

/**
 * Edge Function: ocr-google
 * Recibe un archivo en base64, llama a Google Document AI y retorna el texto crudo.
 * Req 6.8, 13.1 — credenciales leídas desde variables de entorno, nunca hardcodeadas.
 *
 * Variables de entorno requeridas:
 *   GOOGLE_CLOUD_PROJECT_ID        — ID del proyecto en Google Cloud
 *   GOOGLE_DOCUMENT_AI_LOCATION    — Región del procesador (default: 'us')
 *   GOOGLE_DOCUMENT_AI_PROCESSOR_ID — ID del procesador Document AI
 *   GOOGLE_CLOUD_API_KEY           — API Key de Google Cloud
 *
 * Request body (JSON):
 *   fileBase64  {string}  — Archivo codificado en base64 (requerido)
 *   mimeType    {string}  — MIME type del archivo (default: 'application/pdf')
 *   fileName    {string}  — Nombre del archivo (opcional, para logging)
 *
 * Response body (JSON):
 *   rawText     {string}  — Texto extraído del documento
 *   rawResponse {object}  — { pages: number, confidence: number | null }
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Solo aceptar POST
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Método no permitido. Use POST.' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  try {
    // Parsear body
    let body: { fileBase64?: string; mimeType?: string; fileName?: string }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Body inválido. Se esperaba JSON con campo fileBase64.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { fileBase64, mimeType, fileName } = body

    if (!fileBase64) {
      return new Response(
        JSON.stringify({ error: 'fileBase64 es requerido' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Credenciales desde variables de entorno de Supabase (Req 13.1)
    const projectId   = Deno.env.get('GOOGLE_CLOUD_PROJECT_ID')
    const location    = Deno.env.get('GOOGLE_DOCUMENT_AI_LOCATION') ?? 'us'
    const processorId = Deno.env.get('GOOGLE_DOCUMENT_AI_PROCESSOR_ID')
    const apiKey      = Deno.env.get('GOOGLE_CLOUD_API_KEY')

    // Verificar credenciales y reportar cuáles faltan (Req 13.1)
    const missingVars: string[] = []
    if (!projectId)   missingVars.push('GOOGLE_CLOUD_PROJECT_ID')
    if (!processorId) missingVars.push('GOOGLE_DOCUMENT_AI_PROCESSOR_ID')
    if (!apiKey)      missingVars.push('GOOGLE_CLOUD_API_KEY')

    if (missingVars.length > 0) {
      return new Response(
        JSON.stringify({
          error: `Credenciales de Google Document AI no configuradas. Variables faltantes: ${missingVars.join(', ')}`,
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Logging (sin exponer credenciales)
    console.log(`ocr-google: procesando archivo${fileName ? ` "${fileName}"` : ''}, mimeType=${mimeType ?? 'application/pdf'}`)

    // Llamar a Google Document AI API
    const endpoint = `https://documentai.googleapis.com/v1/projects/${projectId}/locations/${location}/processors/${processorId}:process?key=${apiKey}`

    const apiResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawDocument: {
          content:  fileBase64,
          mimeType: mimeType ?? 'application/pdf',
        },
      }),
    })

    if (!apiResponse.ok) {
      const errBody = await apiResponse.text()
      console.error(`ocr-google: Google Document AI API error ${apiResponse.status}:`, errBody)
      throw new Error(`Google Document AI API error ${apiResponse.status}: ${errBody}`)
    }

    const docAiResult = await apiResponse.json()

    // Extraer texto del resultado
    const rawText: string = docAiResult?.document?.text ?? ''

    // Calcular confianza promedio a partir de los bloques de todas las páginas
    // Document AI retorna confidence por bloque en pages[].blocks[].layout.confidence
    const pages = docAiResult?.document?.pages ?? []
    const pageCount: number = pages.length

    let confidence: number | null = null
    const allConfidences: number[] = []

    for (const page of pages) {
      const blocks = page?.blocks ?? []
      for (const block of blocks) {
        const blockConf = block?.layout?.confidence
        if (typeof blockConf === 'number' && !isNaN(blockConf)) {
          allConfidences.push(blockConf)
        }
      }
    }

    if (allConfidences.length > 0) {
      const sum = allConfidences.reduce((acc, c) => acc + c, 0)
      confidence = sum / allConfidences.length
    }

    console.log(`ocr-google: extracción completada. Páginas: ${pageCount}, confianza promedio: ${confidence?.toFixed(3) ?? 'N/A'}`)

    return new Response(
      JSON.stringify({
        rawText,
        rawResponse: {
          pages:      pageCount,
          confidence: confidence,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error interno'
    console.error('ocr-google error:', message)
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
