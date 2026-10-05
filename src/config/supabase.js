import { createClient } from '@supabase/supabase-js'
import { env } from './env.js'

/** Business queries use the caller's JWT so Postgres enforces RLS. */
export function createUserClient(token) {
  return createClient(env.supabase.url, env.supabase.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

/** Only ARCA operations may use the elevated key. */
export function createAdminClient() {
  if (!env.supabase.serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY es requerida para emitir con ARCA')
  }
  return createClient(env.supabase.url, env.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
