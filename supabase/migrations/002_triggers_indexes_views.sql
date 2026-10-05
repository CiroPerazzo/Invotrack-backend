-- ============================================================
-- Migration: 002_triggers_indexes_views.sql
-- InvoTrack — Triggers, Indexes & Analytical Views
--
-- OBJETIVO: Crear triggers de auditoría, índices de rendimiento
-- y vistas analíticas para el sistema InvoTrack.
--
-- CONTENIDO:
--   1. Función update_updated_at() + triggers BEFORE UPDATE
--      en invoices, clients, providers
--   2. Función handle_new_user() + trigger on_auth_user_created
--      en auth.users (AFTER INSERT)
--   3. Índices de rendimiento (IF NOT EXISTS) en tablas clave
--   4. Vista invoice_financial_summary
--   5. Vista company_cash_flow
--
-- Requirements: 12.4, 12.5, 12.6
-- ============================================================


-- ============================================================
-- 1. FUNCIÓN: update_updated_at
--    Actualiza el campo updated_at al momento actual.
--    Usada por triggers BEFORE UPDATE en invoices, clients,
--    providers (Requirement 12.4).
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


-- ============================================================
-- 2. TRIGGERS: updated_at en tablas de negocio
--    Se eliminan primero para garantizar idempotencia.
--    (Requirement 12.4)
-- ============================================================

-- invoices
DROP TRIGGER IF EXISTS invoices_updated_at ON invoices;
CREATE TRIGGER invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- clients
DROP TRIGGER IF EXISTS clients_updated_at ON clients;
CREATE TRIGGER clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- providers
DROP TRIGGER IF EXISTS providers_updated_at ON providers;
CREATE TRIGGER providers_updated_at
  BEFORE UPDATE ON providers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================
-- 3. FUNCIÓN: handle_new_user
--    Crea automáticamente un perfil en la tabla profiles
--    cuando se registra un nuevo usuario en auth.users.
--    SECURITY DEFINER: se ejecuta con privilegios del owner
--    para poder insertar en profiles sin restricciones RLS.
--    (Requirement 12.4)
-- ============================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$;


-- ============================================================
-- 4. TRIGGER: on_auth_user_created
--    Se dispara AFTER INSERT en auth.users para crear el perfil.
--    (Requirement 12.4)
-- ============================================================
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ============================================================
-- 5. ÍNDICES DE RENDIMIENTO
--    Todos usan IF NOT EXISTS para ser idempotentes.
--    Optimizan las consultas más frecuentes filtradas por
--    company_id (Requirement 12.5).
-- ============================================================

-- invoices: filtrado por empresa
CREATE INDEX IF NOT EXISTS idx_invoices_company
  ON invoices(company_id);

-- invoices: filtrado por empresa + estado (listados con filtro de status)
CREATE INDEX IF NOT EXISTS idx_invoices_company_status
  ON invoices(company_id, status);

-- invoices: filtrado por empresa + fecha de emisión (reportes y dashboard)
CREATE INDEX IF NOT EXISTS idx_invoices_company_fecha
  ON invoices(company_id, fecha_emision);

-- invoice_items: acceso por factura (joins en getById y getAll)
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice
  ON invoice_items(invoice_id);

-- clients: filtrado por empresa
CREATE INDEX IF NOT EXISTS idx_clients_company
  ON clients(company_id);

-- providers: filtrado por empresa
CREATE INDEX IF NOT EXISTS idx_providers_company
  ON providers(company_id);


-- ============================================================
-- 6. VISTA: invoice_financial_summary
--    Agrega datos de facturas con sus pagos reales.
--    Calcula: total_paid, total_pending, is_fully_paid, is_overdue.
--    Usada por el dashboard y el módulo de reportes.
--    (Requirement 12.6)
-- ============================================================
CREATE OR REPLACE VIEW invoice_financial_summary AS
SELECT
  i.id                                                          AS invoice_id,
  i.company_id,
  i.type,
  i.status,
  i.total_amount,
  i.fecha_emision                                               AS issue_date,
  i.fecha_vencimiento                                           AS due_date,
  i.moneda                                                      AS currency,
  COALESCE(SUM(p.amount), 0)                                    AS total_paid,
  GREATEST(i.total_amount - COALESCE(SUM(p.amount), 0), 0)     AS total_pending,
  COALESCE(SUM(p.amount), 0) >= i.total_amount                  AS is_fully_paid,
  i.fecha_vencimiento < CURRENT_DATE
    AND COALESCE(SUM(p.amount), 0) < i.total_amount             AS is_overdue
FROM invoices i
LEFT JOIN invoice_payments p ON p.invoice_id = i.id
GROUP BY i.id;


-- ============================================================
-- 7. VISTA: company_cash_flow
--    Agrega el flujo de caja por empresa, tipo de flujo y moneda.
--    Calcula: invoice_count, total_invoiced, total_collected,
--             total_pending, total_overdue.
--    IMPORTANTE: total_collected se basa en pagos reales de
--    invoice_payments, NO en el campo status de la factura.
--    (Requirement 12.6, 11.4)
-- ============================================================
CREATE OR REPLACE VIEW company_cash_flow AS
SELECT
  i.company_id,
  i.type,
  i.moneda                                                                    AS currency,
  COUNT(i.id)                                                                 AS invoice_count,
  SUM(i.total_amount)                                                         AS total_invoiced,
  COALESCE(SUM(s.total_paid), 0)                                              AS total_collected,
  COALESCE(SUM(s.total_pending), 0)                                           AS total_pending,
  COALESCE(SUM(CASE WHEN s.is_overdue THEN s.total_pending ELSE 0 END), 0)   AS total_overdue
FROM invoices i
LEFT JOIN invoice_financial_summary s ON s.invoice_id = i.id
GROUP BY i.company_id, i.type, i.moneda;


-- ============================================================
-- DONE
-- Triggers de updated_at activos en invoices, clients, providers.
-- Trigger on_auth_user_created activo en auth.users.
-- Índices de rendimiento creados (idempotentes con IF NOT EXISTS).
-- Vistas invoice_financial_summary y company_cash_flow creadas.
-- Requirements 12.4, 12.5, 12.6 implementados.
-- ============================================================
