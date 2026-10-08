import express from 'express'
import cors from 'cors'
import { env } from './config/env.js'
import invoiceRoutes from './routes/invoiceRoutes.js'
import catalogRoutes from './routes/catalogRoutes.js'
import authRoutes from './routes/authRoutes.js'
import purchaseOrderRoutes from './routes/purchaseOrderRoutes.js'
import { errorHandler } from './middleware/errorHandler.js'

const app = express()

app.use(cors({ origin: env.corsOrigin, credentials: true }))
app.use(express.json({ limit: '2mb' }))
app.use('/api/v1', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin')
    if (origin && origin !== env.corsOrigin) return res.status(403).json({ error: 'Origen no permitido' })
  }
  next()
})

app.use('/api/v1', authRoutes)
app.use('/api/v1', purchaseOrderRoutes)
app.use('/api/v1', invoiceRoutes)
app.use('/api/v1', catalogRoutes)

app.use(errorHandler)

export default app
