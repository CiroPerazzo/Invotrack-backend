import { Router } from 'express'
import { invoiceController } from '../controllers/InvoiceController.js'
import { authMiddleware, companyScopeMiddleware, requireCompanyRole } from '../middleware/authMiddleware.js'

const router = Router()

router.get('/health', invoiceController.health)

router.post(
  '/invoices/emit',
  authMiddleware,
  companyScopeMiddleware,
  requireCompanyRole('admin', 'accountant'),
  invoiceController.emit
)

export default router
