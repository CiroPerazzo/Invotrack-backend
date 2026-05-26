import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * Edge Function: check-alerts
 *
 * Detecta facturas vencidas (overdue) y próximas a vencer (upcoming, ≤7 días)
 * e inserta alertas en la tabla `alerts` para la empresa correspondiente.
 *
 * Diseñada para ejecutarse como cron job (Supabase pg_cron o invocación manual).
 *
 * Requirements: 10.1, 10.2
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
    const supabaseUrl  = Deno.env.get('SUPABASE_URL')
    const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !serviceKey) {
      return new Response(
        JSON.stringify({ error: 'Variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no configuradas' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Usar service role para poder leer todas las empresas (bypass RLS)
    const supabase = createClient(supabaseUrl, serviceKey)

    const today = new Date()
    const todayStr = today.toISOString().split('T')[0]

    // Fecha límite para "próximas a vencer" (hoy + 7 días)
    const upcoming = new Date(today)
    upcoming.setDate(upcoming.getDate() + 7)
    const upcomingStr = upcoming.toISOString().split('T')[0]

    // 1. Facturas vencidas: fecha_vencimiento < hoy y status != 'paid' y != 'cancelled'
    const { data: overdueInvoices, error: overdueError } = await supabase
      .from('invoices')
      .select('id, company_id, invoice_number, fecha_vencimiento, total_amount')
      .lt('fecha_vencimiento', todayStr)
      .not('status', 'in', '("paid","cancelled")')

    if (overdueError) throw overdueError

    // 2. Facturas próximas a vencer: fecha_vencimiento entre hoy y hoy+7 días
    const { data: upcomingInvoices, error: upcomingError } = await supabase
      .from('invoices')
      .select('id, company_id, invoice_number, fecha_vencimiento, total_amount')
      .gte('fecha_vencimiento', todayStr)
      .lte('fecha_vencimiento', upcomingStr)
      .not('status', 'in', '("paid","cancelled")')

    if (upcomingError) throw upcomingError

    const alertsToInsert: Array<{
      company_id: string
      invoice_id: string
      type: string
      message: string
      is_read: boolean
    }> = []

    // Evitar duplicados: obtener alertas ya existentes del día de hoy
    const { data: existingAlerts } = await supabase
      .from('alerts')
      .select('invoice_id, type')
      .gte('created_at', `${todayStr}T00:00:00Z`)

    const existingSet = new Set(
      (existingAlerts ?? []).map((a: { invoice_id: string; type: string }) => `${a.invoice_id}:${a.type}`)
    )

    // Preparar alertas de facturas vencidas
    for (const inv of overdueInvoices ?? []) {
      const key = `${inv.id}:overdue`
      if (!existingSet.has(key)) {
        alertsToInsert.push({
          company_id: inv.company_id,
          invoice_id: inv.id,
          type: 'overdue',
          message: `La factura ${inv.invoice_number} venció el ${inv.fecha_vencimiento}`,
          is_read: false,
        })
      }
    }

    // Preparar alertas de facturas próximas a vencer
    for (const inv of upcomingInvoices ?? []) {
      const key = `${inv.id}:upcoming`
      if (!existingSet.has(key)) {
        const dueDate = new Date(inv.fecha_vencimiento)
        const diffDays = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
        const daysText = diffDays === 0 ? 'hoy' : diffDays === 1 ? 'mañana' : `en ${diffDays} días`
        alertsToInsert.push({
          company_id: inv.company_id,
          invoice_id: inv.id,
          type: 'upcoming',
          message: `La factura ${inv.invoice_number} vence ${daysText} (${inv.fecha_vencimiento})`,
          is_read: false,
        })
      }
    }

    // Insertar alertas nuevas
    let inserted = 0
    if (alertsToInsert.length > 0) {
      const { error: insertError } = await supabase
        .from('alerts')
        .insert(alertsToInsert)

      if (insertError) throw insertError
      inserted = alertsToInsert.length
    }

    // Disparar emails para alertas nuevas (si hay email configurado en el perfil)
    // Solo intentar si la Edge Function send-notification está disponible
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    if (supabaseUrl && alertsToInsert.length > 0) {
      for (const alert of alertsToInsert) {
        try {
          // Obtener email del owner de la empresa
          const { data: company } = await supabase
            .from('companies')
            .select('name, owner_id, profiles(id)')
            .eq('id', alert.company_id)
            .single()

          const { data: profile } = await supabase
            .from('profiles')
            .select('id')
            .eq('id', company?.owner_id)
            .single()

          // Obtener email desde auth.users (requiere service role)
          const { data: { user } } = await supabase.auth.admin.getUserById(company?.owner_id ?? '')

          if (user?.email) {
            const invoice = (overdueInvoices ?? []).concat(upcomingInvoices ?? [])
              .find((i: { id: string }) => i.id === alert.invoice_id)

            await fetch(`${supabaseUrl}/functions/v1/send-notification`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${serviceKey}`,
              },
              body: JSON.stringify({
                to: user.email,
                template: alert.type,
                data: {
                  companyName: company?.name,
                  invoiceNumber: invoice?.invoice_number,
                  amount: invoice?.total_amount,
                  dueDate: invoice?.fecha_vencimiento,
                },
              }),
            })
          }
        } catch (emailErr) {
          // No bloquear el flujo si el email falla
          console.warn('check-alerts: no se pudo enviar email:', emailErr instanceof Error ? emailErr.message : emailErr)
        }
      }
    }

    console.log(`check-alerts: ${inserted} alertas insertadas (${overdueInvoices?.length ?? 0} vencidas, ${upcomingInvoices?.length ?? 0} próximas)`)

    return new Response(
      JSON.stringify({
        success: true,
        inserted,
        overdue: overdueInvoices?.length ?? 0,
        upcoming: upcomingInvoices?.length ?? 0,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error interno'
    console.error('check-alerts error:', message)
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
