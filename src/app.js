import express from 'express'
import cors from 'cors'
import { env } from './config/env.js'
import invoiceRoutes from './routes/invoiceRoutes.js'
import catalogRoutes from './routes/catalogRoutes.js'
import { errorHandler } from './middleware/errorHandler.js'

const app = express()

app.use(cors({ origin: env.corsOrigin, credentials: true }))
app.use(express.json({ limit: '2mb' }))

app.use('/api/v1', invoiceRoutes)
app.use('/api/v1', catalogRoutes)

app.use(errorHandler)

export default app
