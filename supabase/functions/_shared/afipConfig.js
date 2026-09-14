/**
 * afipConfig - lectura universal de los secretos de ARCA.
 *
 * Un único punto de lectura para los 3 secretos (nunca expone sus valores):
 *   Arca.crt   → certificado X.509 (PEM o base64)
 *   Arca.key   → clave privada RSA (PEM o base64)
 *   Arca.CUIT  → CUIT de 11 dígitos (fallback: se extrae del certificado)
 *
 * También soporta los nombres legacy AFIP_CERT / AFIP_KEY / AFIP_CUIT.
 *
 * BLOQUEO DE PRODUCCIÓN (FIREWALL):
 *   Este sistema está deliberadamente atado a HOMOLOGACIÓN. La variable
 *   AFIP_ENVIRONMENT se IGNORA por completo y el ambiente resuelto es siempre
 *   'testing'. Mientras este bloqueo esté activo es IMPOSIBLE emitir un
 *   comprobante real contra ARCA producción.
 */
import { parseCuitFromCert } from './afipWsaa.js'

/** Ambiente forzado por configuración. Para activar producción hay que borrar este bloqueo a propósito. */
const FORZADO_A_TESTING = true

function readPemEnv(value) {
  if (!value) return null
  // Si el secreto ya viene como PEM lo usamos directo; si viene en base64 lo decodificamos.
  return value.includes('-----BEGIN') ? value : atob(value.replace(/\s+/g, ''))
}

/**
 * Lee y resuelve la configuración AFIP/ARCA.
 * @returns {{
 *   cert: string|null,
 *   key: string|null,
 *   cuit: string|null,
 *   environment: string,
 *   secrets: { crt: boolean, key: boolean, cuit: boolean },
 * } | null} null si falta algo (o sin secretos configurados).
 */
export function loadAfipConfig() {
  const secrets = {
    crt: Boolean(Deno.env.get('Arca.crt') ?? Deno.env.get('AFIP_CERT')),
    key: Boolean(Deno.env.get('Arca.key') ?? Deno.env.get('AFIP_KEY')),
    cuit: Boolean(Deno.env.get('Arca.CUIT') ?? Deno.env.get('AFIP_CUIT')),
  }

  const cert = readPemEnv(Deno.env.get('Arca.crt') ?? Deno.env.get('AFIP_CERT'))
  const key = readPemEnv(Deno.env.get('Arca.key') ?? Deno.env.get('AFIP_KEY'))
  const cuit = (Deno.env.get('Arca.CUIT') ?? Deno.env.get('AFIP_CUIT') ?? '').replace(/\D/g, '') ||
    parseCuitFromCert(cert)
  // AFIP_ENVIRONMENT se ignora a propósito: siempre homologación.
  const environment = FORZADO_A_TESTING
    ? 'testing'
    : (Deno.env.get('AFIP_ENVIRONMENT') ?? 'testing')

  if (!cert || !key || !cuit) {
    return { cert: null, key: null, cuit: null, environment, secrets }
  }
  return { cert, key, cuit: String(cuit).replace(/\D/g, ''), environment, secrets }
}

/** Muestra qué secretos están configurados y el CUIT (sin exponer valores). */
export function diagnoseConfig() {
  const cfg = loadAfipConfig()
  return {
    secrets: cfg.secrets,
    cuit: cfg.cuit ?? null,
    cuitSource: cfg.cuit ? (cfg.secrets.cuit ? 'Arca.CUIT' : 'certificado') : null,
    environment: cfg.environment,
    completo: Boolean(cfg.cert && cfg.key && cfg.cuit),
  }
}
