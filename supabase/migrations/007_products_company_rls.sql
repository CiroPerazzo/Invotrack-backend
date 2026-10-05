-- Products must follow the same company roles as clients and providers.
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "products_own" ON products;
DROP POLICY IF EXISTS "products_company_select" ON products;
DROP POLICY IF EXISTS "products_company_insert" ON products;
DROP POLICY IF EXISTS "products_company_update" ON products;
DROP POLICY IF EXISTS "products_company_delete" ON products;

CREATE POLICY "products_company_select" ON products
  FOR SELECT USING (is_company_member(company_id));

CREATE POLICY "products_company_insert" ON products
  FOR INSERT WITH CHECK (can_write_company(company_id));

CREATE POLICY "products_company_update" ON products
  FOR UPDATE USING (can_write_company(company_id))
  WITH CHECK (can_write_company(company_id));

CREATE POLICY "products_company_delete" ON products
  FOR DELETE USING (can_delete_company(company_id));
