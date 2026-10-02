export function errorHandler(err, _req, res, _next) {
  void _next
  console.error('[server]', err)

  if (['PGRST200', 'PGRST204', 'PGRST205', '42703', '42P01'].includes(err.code)) {
    return res.status(503).json({
      error: 'La base de datos necesita una actualización. Contactá al administrador para completar la configuración.',
    })
  }

  const status = err.status ?? ({ '23505': 409, '23503': 400, '23514': 400, '42501': 403, '22P02': 400 }[err.code] ?? 500)
  const message = status >= 500 ? 'Error interno del servidor' : (err.message ?? 'Solicitud inválida')

  res.status(status).json({
    error: message,
  })
}
