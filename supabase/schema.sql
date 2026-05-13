-- ============================================================
-- InvoTrack — Supabase Schema
-- Multi-company ready, RLS enabled
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- PROFILES
-- ============================================================
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  avatar_url TEXT,
  role TEXT DEFAULT 'admin' CHECK (role IN ('admin', 'accountant', 'viewer')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- COMPANIES (multi-company support)
-- ============================================================
CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  cuit TEXT,
  address TEXT,
  tax_condition TEXT,
  logo_url TEXT,
  owner_id UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- USER ROLES (per company)
-- ============================================================
CREATE TABLE user_roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'viewer' CHECK (role IN ('admin', 'accountant', 'viewer')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, company_id)
);

-- ============================================================
-- CATEGORIES
-- ============================================================
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#3b82f6',
  type TEXT CHECK (type IN ('income', 'expense', 'both')) DEFAULT 'both',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CLIENTS
-- ============================================================
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id),
  name TEXT NOT NULL,
  cuit TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  tax_condition TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PROVIDERS
-- ============================================================
CREATE TABLE providers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id),
  name TEXT NOT NULL,
  cuit TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  tax_condition TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INVOICES
-- ============================================================
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id),
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  provider_id UUID REFERENCES providers(id) ON DELETE SET NULL,
  invoice_number TEXT NOT NULL,
  invoice_type TEXT NOT NULL DEFAULT 'Factura B',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('draft', 'pending', 'paid', 'overdue', 'cancelled')),
  -- receivable = client owes us (income) | payable = we owe provider (expense)
  type TEXT NOT NULL DEFAULT 'receivable'
    CHECK (type IN ('receivable', 'payable')),
  issue_date DATE NOT NULL,
  due_date DATE,
  currency TEXT DEFAULT 'ARS',
  subtotal NUMERIC(15, 2) DEFAULT 0,
  total_iva NUMERIC(15, 2) DEFAULT 0,
  total_amount NUMERIC(15, 2) DEFAULT 0,
  notes TEXT,
  -- AFIP fields (future)
  cae TEXT,
  cae_expiry DATE,
  afip_status TEXT,
  -- OCR metadata
  ocr_provider TEXT,
  ocr_confidence JSONB,
  ocr_raw_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INVOICE ITEMS
-- ============================================================
CREATE TABLE invoice_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(10, 4) NOT NULL DEFAULT 1,
  unit_price NUMERIC(15, 2) NOT NULL DEFAULT 0,
  iva_rate NUMERIC(5, 2) DEFAULT 21,
  subtotal NUMERIC(15, 2) DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INVOICE PAYMENTS
-- Supports partial payments — source of truth for cash flow
-- ============================================================
CREATE TABLE invoice_payments (
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
-- ATTACHMENTS
-- ============================================================
CREATE TABLE attachments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id),
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ALERTS
-- ============================================================
CREATE TABLE alerts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id),
  invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
  type TEXT CHECK (type IN ('overdue', 'upcoming', 'duplicate', 'anomaly')),
  message TEXT,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AUDIT LOGS
-- ============================================================
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID REFERENCES companies(id),
  user_id UUID REFERENCES profiles(id),
  action TEXT NOT NULL,
  table_name TEXT,
  record_id UUID,
  old_data JSONB,
  new_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

-- Profiles: users can only see/edit their own profile
CREATE POLICY "profiles_own" ON profiles
  FOR ALL USING (auth.uid() = id);

-- Companies: owner has full access
CREATE POLICY "companies_owner_access" ON companies
  FOR ALL USING (auth.uid() = owner_id);

-- Companies: members with a role can read
CREATE POLICY "companies_member_read" ON companies
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = companies.id
        AND user_roles.user_id = auth.uid()
    )
  );

-- User roles: users see their own role assignments
CREATE POLICY "user_roles_own" ON user_roles
  FOR ALL USING (auth.uid() = user_id);

-- Clients: users can only see their own clients
CREATE POLICY "clients_own" ON clients
  FOR ALL USING (auth.uid() = user_id);

-- Providers: users can only see their own providers
CREATE POLICY "providers_own" ON providers
  FOR ALL USING (auth.uid() = user_id);

-- Invoices: users can only see their own invoices
CREATE POLICY "invoices_own" ON invoices
  FOR ALL USING (auth.uid() = user_id);

-- Invoice items: accessible through invoice ownership
CREATE POLICY "invoice_items_own" ON invoice_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM invoices
      WHERE invoices.id = invoice_items.invoice_id
      AND invoices.user_id = auth.uid()
    )
  );

-- Invoice payments: users see their own payment records
CREATE POLICY "invoice_payments_own" ON invoice_payments
  FOR ALL USING (auth.uid() = user_id);

-- Attachments: accessible through invoice ownership
CREATE POLICY "attachments_own" ON attachments
  FOR ALL USING (auth.uid() = user_id);

-- Alerts: users see their own alerts
CREATE POLICY "alerts_own" ON alerts
  FOR ALL USING (auth.uid() = user_id);

-- Categories: owner or member of the company
CREATE POLICY "categories_company_access" ON categories
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM companies
      WHERE companies.id = categories.company_id
        AND companies.owner_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.company_id = categories.company_id
        AND user_roles.user_id = auth.uid()
    )
  );

-- ============================================================
-- TRIGGERS: auto-update updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER clients_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER providers_updated_at BEFORE UPDATE ON providers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- TRIGGER: auto-create profile on signup
-- ============================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, full_name)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_invoices_user_id ON invoices(user_id);
CREATE INDEX idx_invoices_company_id ON invoices(company_id);
CREATE INDEX idx_invoices_type ON invoices(type);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_issue_date ON invoices(issue_date);
CREATE INDEX idx_invoices_due_date ON invoices(due_date);
CREATE INDEX idx_invoices_company_type_status ON invoices(company_id, type, status);
CREATE INDEX idx_invoice_items_invoice_id ON invoice_items(invoice_id);
CREATE INDEX idx_invoice_payments_invoice_id ON invoice_payments(invoice_id);
CREATE INDEX idx_invoice_payments_company_id ON invoice_payments(company_id);
CREATE INDEX idx_invoice_payments_user_id ON invoice_payments(user_id);
CREATE INDEX idx_invoice_payments_payment_date ON invoice_payments(payment_date);
CREATE INDEX idx_invoice_payments_company_date ON invoice_payments(company_id, payment_date);
CREATE INDEX idx_clients_user_id ON clients(user_id);
CREATE INDEX idx_providers_user_id ON providers(user_id);
CREATE INDEX idx_alerts_user_id ON alerts(user_id);
CREATE INDEX idx_alerts_is_read ON alerts(is_read);

-- ============================================================
-- VIEWS: financial analytics
-- ============================================================

-- Per-invoice: paid vs pending from real payment records
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

-- Per-company: receivable vs payable cash flow
CREATE OR REPLACE VIEW company_cash_flow AS
SELECT
  i.company_id,
  i.type,
  i.currency,
  COUNT(i.id)                                           AS invoice_count,
  SUM(i.total_amount)                                   AS total_invoiced,
  COALESCE(SUM(p_totals.paid), 0)                       AS total_collected,
  SUM(i.total_amount) - COALESCE(SUM(p_totals.paid), 0) AS total_pending,
  SUM(CASE
    WHEN i.due_date < CURRENT_DATE
     AND COALESCE(p_totals.paid, 0) < i.total_amount
     AND i.status != 'cancelled'
    THEN i.total_amount - COALESCE(p_totals.paid, 0)
    ELSE 0
  END)                                                  AS total_overdue
FROM invoices i
LEFT JOIN (
  SELECT invoice_id, SUM(amount) AS paid
  FROM invoice_payments
  GROUP BY invoice_id
) p_totals ON p_totals.invoice_id = i.id
WHERE i.status != 'cancelled'
GROUP BY i.company_id, i.type, i.currency;
