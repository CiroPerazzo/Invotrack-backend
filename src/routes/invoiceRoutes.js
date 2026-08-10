import { Router } from 'express'
import { invoiceController } from '../controllers/InvoiceController.js'
import { authMiddleware, companyScopeMiddleware } from '../middleware/authMiddleware.js'

const router = Router()

router.get('/health', invoiceController.health)

router.post(
  '/invoices/emit',
  authMiddleware,
  companyScopeMiddleware,
  invoiceController.emit
)

export default router
