import express from 'express'
import cors from 'cors'
import { env } from './config/env.js'
import invoiceRoutes from './routes/invoiceRoutes.js'
import { errorHandler } from './middleware/errorHandler.js'

const app = express()

app.use(cors({ origin: env.corsOrigin, credentials: true }))
app.use(express.json({ limit: '2mb' }))

app.use('/api/v1', invoiceRoutes)

app.use(errorHandler)

app.listen(env.port, () => {
  console.log(`InvoTrack API escuchando en http://localhost:${env.port}`)
})

export default app
