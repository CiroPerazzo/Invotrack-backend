-- ============================================================
-- Migration: 001_rls_company_isolation.sql
-- InvoTrack — RLS Company Isolation
--
-- OBJETIVO: Implementar aislamiento de datos por company_id
-- en todas las tablas de negocio usando RLS.
--
-- POLÍTICA BASE (Requirements 12.1, 12.2, 12.3, 4.9):
--   El usuario autenticado debe:
--     (a) ser el owner_id de la empresa (companies.owner_id = auth.uid()), O
--     (b) tener un registro en user_roles para el company_id de la fila
--
-- ROLES Y PERMISOS:
--   admin      → SELECT, INSERT, UPDATE, DELETE
--   accountant → SELECT, INSERT, UPDATE (sin DELETE)
--   viewer     → solo SELECT
--
-- TABLAS CON company_id DIRECTO:
--   invoices, clients, providers, alerts, invoice_payments
--
-- TABLAS CON ACCESO TRANSITIVO VIA invoice_id:
--   invoice_items, attachments
--
-- NOTA: RLS NUNCA debe desactivarse (Requirement 4.9, 16.1)
-- ============================================================

-- ============================================================
-- HELPER: función auxiliar para verificar membresía en empresa
-- Retorna TRUE si el usuario es owner o tiene rol en la empresa
-- ============================================================
CREATE OR REPLACE FUNCTION is_company_member(p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM companies
    WHERE id = p_company_id
      AND owner_id = auth.uid()
  )
  OR
  EXISTS (
    SELECT 1 FROM user_roles
    WHERE company_id = p_company_id
      AND user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION can_write_company(p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM companies
    WHERE id = p_company_id
      AND owner_id = auth.uid()
  )
  OR
  EXISTS (
    SELECT 1 FROM user_roles
    WHERE company_id = p_company_id
      AND user_id = auth.uid()
      AND role IN ('admin', 'accountant')
  );
$$;

CREATE OR REPLACE FUNCTION can_delete_company(p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM companies
    WHERE id = p_company_id
      AND owner_id = auth.uid()
  )
  OR
  EXISTS (
    SELECT 1 FROM user_roles
    WHERE company_id = p_company_id
      AND user_id = auth.uid()
      AND role = 'admin'
  );
$$;

-- ============================================================
-- 1. INVOICES
--    Aislamiento por company_id con owner_id + user_roles
-- ============================================================
DROP POLICY IF EXISTS "invoices_own"             ON invoices;
DROP POLICY IF EXISTS "invoices_company"         ON invoices;
DROP POLICY IF EXISTS "invoices_company_select"  ON invoices;
DROP POLICY IF EXISTS "invoices_company_insert"  ON invoices;
DROP POLICY IF EXISTS "invoices_company_update"  ON invoices;
DROP POLICY IF EXISTS "invoices_company_delete"  ON invoices;

CREATE POLICY "invoices_company_select" ON invoices
  FOR SELECT USING (
    is_company_member(company_id)
  );

CREATE POLICY "invoices_company_insert" ON invoices
  FOR INSERT WITH CHECK (
    can_write_company(company_id)
  );

CREATE POLICY "invoices_company_update" ON invoices
  FOR UPDATE USING (
    can_write_company(company_id)
  );

CREATE POLICY "invoices_company_delete" ON invoices
  FOR DELETE USING (
    can_delete_company(company_id)
  );

-- ============================================================
-- 2. CLIENTS
--    Aislamiento por company_id con owner_id + user_roles
-- ============================================================
DROP POLICY IF EXISTS "clients_own"             ON clients;
DROP POLICY IF EXISTS "clients_company"         ON clients;
DROP POLICY IF EXISTS "clients_company_select"  ON clients;
DROP POLICY IF EXISTS "clients_company_insert"  ON clients;
DROP POLICY IF EXISTS "clients_company_update"  ON clients;
DROP POLICY IF EXISTS "clients_company_delete"  ON clients;

CREATE POLICY "clients_company_select" ON clients
  FOR SELECT USING (
    is_company_member(company_id)
  );

CREATE POLICY "clients_company_insert" ON clients
  FOR INSERT WITH CHECK (
    can_write_company(company_id)
  );

CREATE POLICY "clients_company_update" ON clients
  FOR UPDATE USING (
    can_write_company(company_id)
  );

CREATE POLICY "clients_company_delete" ON clients
  FOR DELETE USING (
    can_delete_company(company_id)
  );

-- ============================================================
-- 3. PROVIDERS
--    Aislamiento por company_id con owner_id + user_roles
-- ============================================================
DROP POLICY IF EXISTS "providers_own"             ON providers;
DROP POLICY IF EXISTS "providers_company"         ON providers;
DROP POLICY IF EXISTS "providers_company_select"  ON providers;
DROP POLICY IF EXISTS "providers_company_insert"  ON providers;
DROP POLICY IF EXISTS "providers_company_update"  ON providers;
DROP POLICY IF EXISTS "providers_company_delete"  ON providers;

CREATE POLICY "providers_company_select" ON providers
  FOR SELECT USING (
    is_company_member(company_id)
  );

CREATE POLICY "providers_company_insert" ON providers
  FOR INSERT WITH CHECK (
    can_write_company(company_id)
  );

CREATE POLICY "providers_company_update" ON providers
  FOR UPDATE USING (
    can_write_company(company_id)
  );

CREATE POLICY "providers_company_delete" ON providers
  FOR DELETE USING (
    can_delete_company(company_id)
  );

-- ============================================================
-- 4. ALERTS
--    Aislamiento por company_id con owner_id + user_roles
-- ============================================================
DROP POLICY IF EXISTS "alerts_own"             ON alerts;
DROP POLICY IF EXISTS "alerts_company"         ON alerts;
DROP POLICY IF EXISTS "alerts_company_select"  ON alerts;
DROP POLICY IF EXISTS "alerts_company_insert"  ON alerts;
DROP POLICY IF EXISTS "alerts_company_update"  ON alerts;
DROP POLICY IF EXISTS "alerts_company_delete"  ON alerts;

CREATE POLICY "alerts_company_select" ON alerts
  FOR SELECT USING (
    is_company_member(company_id)
  );

-- Alerts can be inserted by admin/accountant (or system via Edge Functions)
CREATE POLICY "alerts_company_insert" ON alerts
  FOR INSERT WITH CHECK (
    can_write_company(company_id)
  );

-- Alerts can be updated (e.g. mark as read) by any member
CREATE POLICY "alerts_company_update" ON alerts
  FOR UPDATE USING (
    is_company_member(company_id)
  );

CREATE POLICY "alerts_company_delete" ON alerts
  FOR DELETE USING (
    can_delete_company(company_id)
  );

-- ============================================================
-- 5. INVOICE PAYMENTS
--    Aislamiento por company_id con owner_id + user_roles
-- ============================================================
DROP POLICY IF EXISTS "invoice_payments_own"             ON invoice_payments;
DROP POLICY IF EXISTS "invoice_payments_company"         ON invoice_payments;
DROP POLICY IF EXISTS "invoice_payments_company_select"  ON invoice_payments;
DROP POLICY IF EXISTS "invoice_payments_company_insert"  ON invoice_payments;
DROP POLICY IF EXISTS "invoice_payments_company_update"  ON invoice_payments;
DROP POLICY IF EXISTS "invoice_payments_company_delete"  ON invoice_payments;

CREATE POLICY "invoice_payments_company_select" ON invoice_payments
  FOR SELECT USING (
    is_company_member(company_id)
  );

CREATE POLICY "invoice_payments_company_insert" ON invoice_payments
  FOR INSERT WITH CHECK (
    can_write_company(company_id)
  );

CREATE POLICY "invoice_payments_company_update" ON invoice_payments
  FOR UPDATE USING (
    can_write_company(company_id)
  );

CREATE POLICY "invoice_payments_company_delete" ON invoice_payments
  FOR DELETE USING (
    can_delete_company(company_id)
  );

-- ============================================================
-- 6. INVOICE ITEMS
--    Acceso transitivo via invoice_id → company_id
--    No tienen company_id directo (Requirement 12.3)
-- ============================================================
DROP POLICY IF EXISTS "invoice_items_own"             ON invoice_items;
DROP POLICY IF EXISTS "invoice_items_via_invoice"     ON invoice_items;
DROP POLICY IF EXISTS "invoice_items_company_select"  ON invoice_items;
DROP POLICY IF EXISTS "invoice_items_company_insert"  ON invoice_items;
DROP POLICY IF EXISTS "invoice_items_company_update"  ON invoice_items;
DROP POLICY IF EXISTS "invoice_items_company_delete"  ON invoice_items;

CREATE POLICY "invoice_items_company_select" ON invoice_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_items.invoice_id
        AND is_company_member(i.company_id)
    )
  );

CREATE POLICY "invoice_items_company_insert" ON invoice_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_items.invoice_id
        AND can_write_company(i.company_id)
    )
  );

CREATE POLICY "invoice_items_company_update" ON invoice_items
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_items.invoice_id
        AND can_write_company(i.company_id)
    )
  );

CREATE POLICY "invoice_items_company_delete" ON invoice_items
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_items.invoice_id
        AND can_delete_company(i.company_id)
    )
  );

-- ============================================================
-- 7. ATTACHMENTS
--    Acceso transitivo via invoice_id → company_id
--    No tienen company_id directo (Requirement 12.3)
-- ============================================================
DROP POLICY IF EXISTS "attachments_own"             ON attachments;
DROP POLICY IF EXISTS "attachments_via_invoice"     ON attachments;
DROP POLICY IF EXISTS "attachments_company_select"  ON attachments;
DROP POLICY IF EXISTS "attachments_company_insert"  ON attachments;
DROP POLICY IF EXISTS "attachments_company_update"  ON attachments;
DROP POLICY IF EXISTS "attachments_company_delete"  ON attachments;

CREATE POLICY "attachments_company_select" ON attachments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = attachments.invoice_id
        AND is_company_member(i.company_id)
    )
  );

CREATE POLICY "attachments_company_insert" ON attachments
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = attachments.invoice_id
        AND can_write_company(i.company_id)
    )
  );

CREATE POLICY "attachments_company_update" ON attachments
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = attachments.invoice_id
        AND can_write_company(i.company_id)
    )
  );

CREATE POLICY "attachments_company_delete" ON attachments
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = attachments.invoice_id
        AND can_delete_company(i.company_id)
    )
  );

-- ============================================================
-- 8. VERIFICACIÓN: RLS habilitado en todas las tablas
--    (idempotente — no falla si ya está habilitado)
--    Requirement 12.1: RLS habilitado en TODAS las tablas
-- ============================================================
ALTER TABLE profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients          ENABLE ROW LEVEL SECURITY;
ALTER TABLE providers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories       ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs       ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 9. POLÍTICAS PARA TABLAS DE SOPORTE
--    (profiles, companies, user_roles, audit_logs, categories)
--    Requirement 12.3
-- ============================================================

-- profiles: usuario solo accede a su propio perfil
DROP POLICY IF EXISTS "profiles_own" ON profiles;
CREATE POLICY "profiles_own" ON profiles
  FOR ALL USING (auth.uid() = id);

-- companies: owner tiene acceso total; miembros con user_roles pueden leer
DROP POLICY IF EXISTS "companies_owner_access"  ON companies;
DROP POLICY IF EXISTS "companies_owner"         ON companies;
DROP POLICY IF EXISTS "companies_member_read"   ON companies;

CREATE POLICY "companies_owner" ON companies
  FOR ALL USING (owner_id = auth.uid());

CREATE POLICY "companies_member_read" ON companies
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE company_id = companies.id
        AND user_id = auth.uid()
    )
  );

-- user_roles: usuarios ven sus propias asignaciones de rol
--             admins (owner) pueden gestionar roles de su empresa
DROP POLICY IF EXISTS "user_roles_own"          ON user_roles;
DROP POLICY IF EXISTS "user_roles_admin_manage" ON user_roles;

CREATE POLICY "user_roles_own" ON user_roles
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY "user_roles_admin_manage" ON user_roles
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM companies
      WHERE id = user_roles.company_id
        AND owner_id = auth.uid()
    )
  );

-- audit_logs: solo admins (owner) pueden leer los logs de su empresa
DROP POLICY IF EXISTS "audit_logs_admin" ON audit_logs;
CREATE POLICY "audit_logs_admin" ON audit_logs
  FOR SELECT USING (
    company_id IN (
      SELECT id FROM companies WHERE owner_id = auth.uid()
    )
  );

-- categories: owner o miembro con rol puede acceder
DROP POLICY IF EXISTS "categories_company_access" ON categories;
CREATE POLICY "categories_company_access" ON categories
  FOR ALL USING (
    is_company_member(company_id)
  );

-- ============================================================
-- DONE
-- RLS activo en todas las tablas.
-- Aislamiento por company_id implementado.
-- Acceso transitivo via invoice_id para invoice_items y attachments.
-- NUNCA se desactiva RLS (Requirement 4.9, 16.1).
-- ============================================================
