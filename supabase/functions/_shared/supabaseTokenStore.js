/**
 * supabaseTokenStore - caché compartida del TA (WSAA) en una tabla de Supabase.
 *
 * Las edge functions son stateless: sin esta tabla, cada invocación pediría un
 * TA nuevo a WSAA y lo descartaría al terminar → TAs huérfanos y bloqueos por
 * coe.alreadyAuthenticated. Con el store, todas las invocaciones (frontend,
 * validación, emisión) reutilizan el MISMO token+sign hasta que venza.
 *
 * La tabla arca_tokens tiene RLS sin políticas: solo el service_role la accede.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * Crea el store de TA respaldado en la tabla `arca_tokens`.
 * Devuelve null si faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 * (en ese caso la función llama a WSAA en cada invocación, sin caché).
 */
export function createTokenStore() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return null

  const supabase = createClient(supabaseUrl, serviceKey)

  return {
    async loadToken({ service, cuit }) {
      const { data, error } = await supabase
        .from('arca_tokens')
        .select('token, sign, generation_time, expiration_time')
        .eq('service', service)
        .eq('cuit', String(cuit))
        .maybeSingle()
      if (error || !data) return null
      return {
        token: data.token,
        sign: data.sign,
        generationTime: data.generation_time,
        expirationTime: data.expiration_time,
      }
    },

    async saveToken({ service, cuit, token, sign, generationTime, expirationTime }) {
      const { error } = await supabase
        .from('arca_tokens')
        .upsert({
          service,
          cuit: String(cuit),
          token,
          sign,
          generation_time: generationTime,
          expiration_time: expirationTime,
        }, { onConflict: 'service,cuit' })
      if (error) {
        console.error('arca_tokens saveToken:', error.message)
      }
    },
  }
}
