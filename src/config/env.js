import 'dotenv/config'

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
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },
  afip: {
    accessToken: process.env.AFIPSDK_ACCESS_TOKEN ?? '',
    environment: process.env.AFIP_ENVIRONMENT ?? 'development',
    production: process.env.AFIP_ENVIRONMENT === 'production',
    cuit: process.env.AFIP_CUIT ? Number(process.env.AFIP_CUIT.replace(/\D/g, '')) : 20409378472,
    cert: process.env.AFIP_CERT ?? null,
    key: process.env.AFIP_KEY ?? null,
  },
}
