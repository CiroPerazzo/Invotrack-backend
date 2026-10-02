import { config } from 'dotenv'
import { resolve } from 'node:path'

// La configuración del server tiene prioridad; el .env raíz aporta las
// credenciales públicas de Supabase cuando no hay server/.env.
const configDirectory = import.meta.dirname ?? resolve(process.cwd(), 'server/src/config')
config({ path: resolve(configDirectory, '../../.env') })
config({ path: resolve(configDirectory, '../../../.env') })

function required(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Variable de entorno requerida: ${name}`)
  }
  return value
}

export const env = {
  port: Number(process.env.PORT ?? 3001),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  supabase: {
    url: process.env.SUPABASE_URL?.trim() || required('VITE_SUPABASE_URL').trim(),
    anonKey: process.env.SUPABASE_ANON_KEY?.trim() || required('VITE_SUPABASE_ANON_KEY').trim(),
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  },
  afip: {
    accessToken: process.env.AFIPSDK_ACCESS_TOKEN ?? '',
    // BLOQUEO DE PRODUCCIÓN: el server queda forzado a homologación.
    // Para emitir comprobantes reales hay que desactivar este bloqueo a propósito.
    environment: 'testing',
    production: false,
    cuit: process.env.AFIP_CUIT ? Number(process.env.AFIP_CUIT.replace(/\D/g, '')) : 20409378472,
    cert: process.env.AFIP_CERT ?? null,
    key: process.env.AFIP_KEY ?? null,
  },
}
