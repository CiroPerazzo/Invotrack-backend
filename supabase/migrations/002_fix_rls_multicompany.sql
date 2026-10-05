-- ============================================================
-- Migration 002: Fix RLS — multi-company access via user_roles
-- InvoTrack
--
-- OBJETIVO: Reemplazar políticas RLS basadas en user_id (creador)
-- por políticas basadas en company_id + user_roles.
-- Esto permite que todos los miembros de una empresa accedan
-- a los registros de esa empresa según su rol.
--
-- ROLES:
--   admin      → SELECT, INSERT, UPDATE, DELETE
--   accountant → SELECT, INSERT, UPDATE (sin DELETE)
--   viewer     → solo SELECT
--
-- TABLAS AFECTADAS:
--   clients, providers, invoices, invoice_items,
--   invoice_payments, attachments, alerts
-- ============================================================

-- ============================================================
-- 1. CLIENTS
-- ============================================================
DROP POLICY IF EXISTS "clients_own" ON clients;

CREATE POLICY "clients_company_select" ON clients
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = clients.company_id
        AND user_roles.user_id = auth.uid()
    )
  );

CREATE POLICY "clients_company_insert" ON clients
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = clients.company_id
        AND user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'accountant')
    )
  );

CREATE POLICY "clients_company_update" ON clients
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = clients.company_id
        AND user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'accountant')
    )
  );

CREATE POLICY "clients_company_delete" ON clients
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = clients.company_id
        AND user_roles.user_id = auth.uid()
        AND user_roles.role = 'admin'
    )
  );

-- ============================================================
-- 2. PROVIDERS
-- ============================================================
DROP POLICY IF EXISTS "providers_own" ON providers;

CREATE POLICY "providers_company_select" ON providers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = providers.company_id
        AND user_roles.user_id = auth.uid()
    )
  );

CREATE POLICY "providers_company_insert" ON providers
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = providers.company_id
        AND user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'accountant')
    )
  );

CREATE POLICY "providers_company_update" ON providers
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = providers.company_id
        AND user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'accountant')
    )
  );

CREATE POLICY "providers_company_delete" ON providers
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = providers.company_id
        AND user_roles.user_id = auth.uid()
        AND user_roles.role = 'admin'
    )
  );

-- ============================================================
-- 3. INVOICES
-- ============================================================
DROP POLICY IF EXISTS "invoices_own" ON invoices;

CREATE POLICY "invoices_company_select" ON invoices
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = invoices.company_id
        AND user_roles.user_id = auth.uid()
    )
  );

CREATE POLICY "invoices_company_insert" ON invoices
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = invoices.company_id
        AND user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'accountant')
    )
  );

CREATE POLICY "invoices_company_update" ON invoices
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = invoices.company_id
        AND user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'accountant')
    )
  );

CREATE POLICY "invoices_company_delete" ON invoices
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = invoices.company_id
        AND user_roles.user_id = auth.uid()
        AND user_roles.role = 'admin'
    )
  );

-- ============================================================
-- 4. INVOICE ITEMS
--    No tienen company_id directo — JOIN a invoices
-- ============================================================
DROP POLICY IF EXISTS "invoice_items_own" ON invoice_items;

CREATE POLICY "invoice_items_company_select" ON invoice_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM invoices i
      JOIN user_roles ur ON ur.company_id = i.company_id
      WHERE i.id = invoice_items.invoice_id
        AND ur.user_id = auth.uid()
    )
  );

CREATE POLICY "invoice_items_company_insert" ON invoice_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM invoices i
      JOIN user_roles ur ON ur.company_id = i.company_id
      WHERE i.id = invoice_items.invoice_id
        AND ur.user_id = auth.uid()
        AND ur.role IN ('admin', 'accountant')
    )
  );

CREATE POLICY "invoice_items_company_update" ON invoice_items
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM invoices i
      JOIN user_roles ur ON ur.company_id = i.company_id
      WHERE i.id = invoice_items.invoice_id
        AND ur.user_id = auth.uid()
        AND ur.role IN ('admin', 'accountant')
    )
  );

CREATE POLICY "invoice_items_company_delete" ON invoice_items
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM invoices i
      JOIN user_roles ur ON ur.company_id = i.company_id
      WHERE i.id = invoice_items.invoice_id
        AND ur.user_id = auth.uid()
        AND ur.role = 'admin'
    )
  );

-- ============================================================
-- 5. INVOICE PAYMENTS
-- ============================================================
DROP POLICY IF EXISTS "invoice_payments_own" ON invoice_payments;

CREATE POLICY "invoice_payments_company_select" ON invoice_payments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = invoice_payments.company_id
        AND user_roles.user_id = auth.uid()
    )
  );

CREATE POLICY "invoice_payments_company_insert" ON invoice_payments
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = invoice_payments.company_id
        AND user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'accountant')
    )
  );

CREATE POLICY "invoice_payments_company_update" ON invoice_payments
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = invoice_payments.company_id
        AND user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'accountant')
    )
  );

CREATE POLICY "invoice_payments_company_delete" ON invoice_payments
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = invoice_payments.company_id
        AND user_roles.user_id = auth.uid()
        AND user_roles.role = 'admin'
    )
  );

-- ============================================================
-- 6. ATTACHMENTS
--    No tienen company_id directo — JOIN a invoices
-- ============================================================
DROP POLICY IF EXISTS "attachments_own" ON attachments;

CREATE POLICY "attachments_company_select" ON attachments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM invoices i
      JOIN user_roles ur ON ur.company_id = i.company_id
      WHERE i.id = attachments.invoice_id
        AND ur.user_id = auth.uid()
    )
  );

CREATE POLICY "attachments_company_insert" ON attachments
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM invoices i
      JOIN user_roles ur ON ur.company_id = i.company_id
      WHERE i.id = attachments.invoice_id
        AND ur.user_id = auth.uid()
        AND ur.role IN ('admin', 'accountant')
    )
  );

CREATE POLICY "attachments_company_update" ON attachments
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM invoices i
      JOIN user_roles ur ON ur.company_id = i.company_id
      WHERE i.id = attachments.invoice_id
        AND ur.user_id = auth.uid()
        AND ur.role IN ('admin', 'accountant')
    )
  );

CREATE POLICY "attachments_company_delete" ON attachments
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM invoices i
      JOIN user_roles ur ON ur.company_id = i.company_id
      WHERE i.id = attachments.invoice_id
        AND ur.user_id = auth.uid()
        AND ur.role = 'admin'
    )
  );

-- ============================================================
-- 7. ALERTS
-- ============================================================
DROP POLICY IF EXISTS "alerts_own" ON alerts;

CREATE POLICY "alerts_company_select" ON alerts
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = alerts.company_id
        AND user_roles.user_id = auth.uid()
    )
  );

CREATE POLICY "alerts_company_insert" ON alerts
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = alerts.company_id
        AND user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'accountant')
    )
  );

CREATE POLICY "alerts_company_update" ON alerts
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = alerts.company_id
        AND user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'accountant')
    )
  );

CREATE POLICY "alerts_company_delete" ON alerts
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = alerts.company_id
        AND user_roles.user_id = auth.uid()
        AND user_roles.role = 'admin'
    )
  );

-- ============================================================
-- IMPORTANTE: aplicar solo en base limpia o validar que todos
-- los registros existentes tengan company_id asignado antes
-- de ejecutar.
-- ============================================================
