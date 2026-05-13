-- ============================================================
-- Migration 001: invoice_payments + invoice type + companies RLS
-- InvoTrack — Financial accuracy upgrade
-- ============================================================

-- ============================================================
-- 1. ADD TYPE COLUMN TO INVOICES
--    receivable = cliente me debe (ingreso)
--    payable    = yo debo pagar (gasto)
-- ============================================================
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'receivable'
    CHECK (type IN ('receivable', 'payable'));

-- Index for filtering by type (dashboards, analytics)
CREATE INDEX IF NOT EXISTS idx_invoices_type ON invoices(type);

-- Composite index: company + type + status (most common dashboard query)
CREATE INDEX IF NOT EXISTS idx_invoices_company_type_status
  ON invoices(company_id, type, status);

-- ============================================================
-- 2. CREATE invoice_payments TABLE
--    Supports partial payments — source of truth for cash flow
-- ============================================================
CREATE TABLE IF NOT EXISTS invoice_payments (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id     UUID        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  company_id     UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id        UUID        NOT NULL REFERENCES profiles(id),
  amount         NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
  payment_method TEXT        NOT NULL DEFAULT 'transfer'
    CHECK (payment_method IN (
      'transfer', 'cash', 'check', 'credit_card',
      'debit_card', 'crypto', 'other'
    )),
  payment_date   DATE        NOT NULL DEFAULT CURRENT_DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 3. INDEXES FOR invoice_payments
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice_id
  ON invoice_payments(invoice_id);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_company_id
  ON invoice_payments(company_id);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_user_id
  ON invoice_payments(user_id);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_payment_date
  ON invoice_payments(payment_date);

-- Composite: company + date range (cash flow reports)
CREATE INDEX IF NOT EXISTS idx_invoice_payments_company_date
  ON invoice_payments(company_id, payment_date);

-- ============================================================
-- 4. RLS FOR invoice_payments
-- ============================================================
ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoice_payments_own" ON invoice_payments
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- 5. RLS POLICIES FOR companies (MISSING — now added)
--    owner_id = acceso completo
--    user_roles = acceso a su empresa asignada
-- ============================================================

-- Owner has full access to their company
CREATE POLICY "companies_owner_access" ON companies
  FOR ALL USING (auth.uid() = owner_id);

-- Users with a role in the company can read it
CREATE POLICY "companies_member_read" ON companies
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = companies.id
        AND user_roles.user_id = auth.uid()
    )
  );

-- ============================================================
-- 6. RLS FOR user_roles (needed for companies policy above)
-- ============================================================
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_roles_own" ON user_roles
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- 7. RLS FOR categories (was missing policy)
-- ============================================================
CREATE POLICY "categories_company_access" ON categories
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = categories.company_id
        AND user_roles.user_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM companies
      WHERE companies.id = categories.company_id
        AND companies.owner_id = auth.uid()
    )
  );

-- ============================================================
-- 8. COMPUTED VIEW: invoice financial summary
--    Calculates paid/pending dynamically from invoice_payments
--    Use this in dashboards instead of relying on status alone
-- ============================================================
CREATE OR REPLACE VIEW invoice_financial_summary AS
SELECT
  i.id                                          AS invoice_id,
  i.company_id,
  i.user_id,
  i.type,
  i.status,
  i.total_amount,
  i.due_date,
  i.issue_date,
  i.currency,
  COALESCE(SUM(p.amount), 0)                    AS total_paid,
  i.total_amount - COALESCE(SUM(p.amount), 0)   AS total_pending,
  CASE
    WHEN COALESCE(SUM(p.amount), 0) >= i.total_amount THEN true
    ELSE false
  END                                           AS is_fully_paid,
  CASE
    WHEN i.due_date < CURRENT_DATE
     AND COALESCE(SUM(p.amount), 0) < i.total_amount
     AND i.status != 'cancelled'
    THEN true
    ELSE false
  END                                           AS is_overdue
FROM invoices i
LEFT JOIN invoice_payments p ON p.invoice_id = i.id
GROUP BY
  i.id, i.company_id, i.user_id, i.type,
  i.status, i.total_amount, i.due_date,
  i.issue_date, i.currency;

-- ============================================================
-- 9. COMPUTED VIEW: company cash flow summary
--    Aggregates receivable vs payable for financial balance
-- ============================================================
CREATE OR REPLACE VIEW company_cash_flow AS
SELECT
  i.company_id,
  i.type,
  i.currency,
  COUNT(i.id)                                         AS invoice_count,
  SUM(i.total_amount)                                 AS total_invoiced,
  COALESCE(SUM(p_totals.paid), 0)                     AS total_collected,
  SUM(i.total_amount) - COALESCE(SUM(p_totals.paid), 0) AS total_pending,
  SUM(CASE
    WHEN i.due_date < CURRENT_DATE
     AND COALESCE(p_totals.paid, 0) < i.total_amount
     AND i.status != 'cancelled'
    THEN i.total_amount - COALESCE(p_totals.paid, 0)
    ELSE 0
  END)                                                AS total_overdue
FROM invoices i
LEFT JOIN (
  SELECT invoice_id, SUM(amount) AS paid
  FROM invoice_payments
  GROUP BY invoice_id
) p_totals ON p_totals.invoice_id = i.id
WHERE i.status != 'cancelled'
GROUP BY i.company_id, i.type, i.currency;

-- ============================================================
-- DONE
-- ============================================================
