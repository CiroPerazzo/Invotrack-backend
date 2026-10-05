import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'

/**
 * Edge Function: send-notification
 *
 * Envía emails usando la API de Resend.
 * Soporta plantillas: factura vencida, próxima a vencer, resumen semanal.
 *
 * Variables de entorno requeridas:
 *   RESEND_API_KEY   — API Key de Resend (re_xxxxxxxxxxxx)
 *   FROM_EMAIL       — Email remitente (ej: notificaciones@invotrack.app)
 *
 * Requirements: 15.4, 13.1
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type TemplateType = 'overdue' | 'upcoming' | 'weekly_summary'

interface NotificationPayload {
  to: string
  template: TemplateType
  data: {
    companyName?: string
    invoiceNumber?: string
    amount?: number
    dueDate?: string
    daysUntilDue?: number
    totalInvoiced?: number
    totalCollected?: number
    pendingCount?: number
  }
}

function buildEmailContent(template: TemplateType, data: NotificationPayload['data']): { subject: string; html: string } {
  const company = data.companyName ?? 'tu empresa'

  switch (template) {
    case 'overdue':
      return {
        subject: `⚠️ Factura vencida — ${data.invoiceNumber}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #ef4444;">Factura vencida</h2>
            <p>La factura <strong>${data.invoiceNumber}</strong> de <strong>${company}</strong> está vencida.</p>
            <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0;"><strong>Monto:</strong> $${data.amount?.toLocaleString('es-AR') ?? '-'}</p>
              <p style="margin: 8px 0 0;"><strong>Fecha de vencimiento:</strong> ${data.dueDate ?? '-'}</p>
            </div>
            <p>Ingresá a <a href="https://invotrack.app">InvoTrack</a> para gestionar el cobro.</p>
          </div>
        `,
      }

    case 'upcoming':
      return {
        subject: `🔔 Factura próxima a vencer — ${data.invoiceNumber}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #f59e0b;">Factura próxima a vencer</h2>
            <p>La factura <strong>${data.invoiceNumber}</strong> de <strong>${company}</strong> vence en <strong>${data.daysUntilDue} día${data.daysUntilDue !== 1 ? 's' : ''}</strong>.</p>
            <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0;"><strong>Monto:</strong> $${data.amount?.toLocaleString('es-AR') ?? '-'}</p>
              <p style="margin: 8px 0 0;"><strong>Fecha de vencimiento:</strong> ${data.dueDate ?? '-'}</p>
            </div>
            <p>Ingresá a <a href="https://invotrack.app">InvoTrack</a> para gestionar el cobro.</p>
          </div>
        `,
      }

    case 'weekly_summary':
      return {
        subject: `📊 Resumen semanal — ${company}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #3b82f6;">Resumen semanal de ${company}</h2>
            <div style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0;"><strong>Total facturado:</strong> $${data.totalInvoiced?.toLocaleString('es-AR') ?? '0'}</p>
              <p style="margin: 8px 0 0;"><strong>Total cobrado:</strong> $${data.totalCollected?.toLocaleString('es-AR') ?? '0'}</p>
              <p style="margin: 8px 0 0;"><strong>Facturas pendientes:</strong> ${data.pendingCount ?? 0}</p>
            </div>
            <p>Ingresá a <a href="https://invotrack.app">InvoTrack</a> para ver el detalle completo.</p>
          </div>
        `,
      }

    default:
      return { subject: 'Notificación de InvoTrack', html: '<p>Tenés una nueva notificación en InvoTrack.</p>' }
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const resendApiKey = Deno.env.get('RESEND_API_KEY')
    const fromEmail    = Deno.env.get('FROM_EMAIL') ?? 'notificaciones@invotrack.app'

    if (!resendApiKey) {
      return new Response(
        JSON.stringify({ error: 'RESEND_API_KEY no configurada en las variables de entorno de Supabase' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let payload: NotificationPayload
    try {
      payload = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Body inválido. Se esperaba JSON con to, template y data.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { to, template, data } = payload

    if (!to || !template) {
      return new Response(
        JSON.stringify({ error: 'Los campos to y template son requeridos' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { subject, html } = buildEmailContent(template, data ?? {})

    // Llamar a la API de Resend
    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: fromEmail, to, subject, html }),
    })

    if (!resendResponse.ok) {
      const errBody = await resendResponse.text()
      throw new Error(`Resend API error ${resendResponse.status}: ${errBody}`)
    }

    const result = await resendResponse.json()
    console.log(`send-notification: email enviado a ${to}, template=${template}, id=${result.id}`)

    return new Response(
      JSON.stringify({ success: true, emailId: result.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error interno'
    console.error('send-notification error:', message)
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
