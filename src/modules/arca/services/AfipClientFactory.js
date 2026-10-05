import Afip from '@afipsdk/afip.js'
import { env } from '../../../config/env.js'

/**
 * Factory de cliente Afip SDK.
 * @see https://docs.afipsdk.com/integracion/node.js/express.md
 */
export function createAfipClient(overrides = {}) {
  if (!env.afip.accessToken) {
    throw new Error(
      'AFIPSDK_ACCESS_TOKEN no configurado. Obtené uno en https://app.afipsdk.com'
    )
  }

  const options = {
    CUIT: overrides.cuit ?? env.afip.cuit,
    access_token: env.afip.accessToken,
    // BLOQUEO DE PRODUCCIÓN: homologación siempre, ignore cualquier override.
    production: env.afip.production === true,
  }

  const cert = overrides.cert ?? env.afip.cert
  const key = overrides.key ?? env.afip.key

  if (cert && key) {
    options.cert = cert
    options.key = key
  }

  return new Afip(options)
}
