import { createClient } from '@supabase/supabase-js'
import { env } from './env.js'

/** Cliente admin — solo backend, nunca exponer al browser. */
export const supabaseAdmin = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})
