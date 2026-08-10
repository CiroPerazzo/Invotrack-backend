export function errorHandler(err, _req, res, _next) {
  console.error('[server]', err)

  const status = err.status ?? 500
  const message = err.message ?? 'Error interno del servidor'

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && err.stack ? { stack: err.stack } : {}),
  })
}
