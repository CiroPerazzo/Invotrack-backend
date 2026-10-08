-- Purchase orders are supplier purchases. Totals and invoicing progress are
-- derived from immutable item snapshots and allocations, never client totals.
CREATE UNIQUE INDEX IF NOT EXISTS providers_id_company_unique_for_purchase_orders ON providers(id, company_id);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_id_company_unique_for_purchase_orders ON invoices(id, company_id);

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES profiles(id),
  order_number text NOT NULL CHECK (length(trim(order_number)) BETWEEN 1 AND 80),
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'cancelled')),
  notes text CHECK (length(notes) <= 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, order_number),
  UNIQUE (id, company_id),
  FOREIGN KEY (provider_id, company_id) REFERENCES providers(id, company_id) ON DELETE RESTRICT
);

CREATE TABLE purchase_order_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
  quantity numeric(12, 4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(15, 2) NOT NULL CHECK (unit_price >= 0),
  iva_rate numeric(5, 2) NOT NULL DEFAULT 0 CHECK (iva_rate IN (0, 10.5, 21, 27)),
  line_total numeric(15, 2) GENERATED ALWAYS AS
    (round(quantity * unit_price * (1 + iva_rate / 100), 2)) STORED,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0)
);

CREATE TABLE purchase_order_invoices (
  purchase_order_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  company_id uuid NOT NULL,
  allocated_amount numeric(15, 2) NOT NULL CHECK (allocated_amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (purchase_order_id, invoice_id),
  FOREIGN KEY (purchase_order_id, company_id)
    REFERENCES purchase_orders(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (invoice_id, company_id)
    REFERENCES invoices(id, company_id) ON DELETE CASCADE
);

CREATE INDEX idx_purchase_orders_company_provider ON purchase_orders(company_id, provider_id, issue_date DESC);
CREATE INDEX idx_purchase_order_items_order ON purchase_order_items(purchase_order_id);
CREATE INDEX idx_purchase_order_invoices_invoice ON purchase_order_invoices(invoice_id);
CREATE INDEX idx_purchase_order_invoices_company ON purchase_order_invoices(company_id);

CREATE FUNCTION purchase_order_validate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM providers WHERE id = NEW.provider_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'El proveedor no pertenece a la empresa' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id <> OLD.company_id OR NEW.user_id <> OLD.user_id THEN
      RAISE EXCEPTION 'No se puede trasladar una orden de empresa o creador' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM purchase_order_invoices WHERE purchase_order_id = OLD.id)
       AND (NEW.provider_id <> OLD.provider_id OR NEW.status <> OLD.status
            OR NEW.order_number <> OLD.order_number OR NEW.issue_date <> OLD.issue_date) THEN
      RAISE EXCEPTION 'La orden ya tiene facturas vinculadas' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchase_orders_validate BEFORE INSERT OR UPDATE ON purchase_orders
FOR EACH ROW EXECUTE FUNCTION purchase_order_validate();

CREATE FUNCTION purchase_order_item_validate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_order purchase_orders%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO v_order FROM purchase_orders WHERE id = OLD.purchase_order_id FOR UPDATE;
  ELSE
    SELECT * INTO v_order FROM purchase_orders WHERE id = NEW.purchase_order_id FOR UPDATE;
  END IF;
  IF EXISTS (SELECT 1 FROM purchase_order_invoices WHERE purchase_order_id = v_order.id) THEN
    IF TG_OP <> 'UPDATE' THEN
      RAISE EXCEPTION 'No se pueden cambiar ítems de una orden facturada' USING ERRCODE = '23514';
    END IF;
    IF NEW.purchase_order_id <> OLD.purchase_order_id
       OR NEW.product_id IS NOT NULL OR OLD.product_id IS NULL
       OR NEW.description <> OLD.description OR NEW.quantity <> OLD.quantity
       OR NEW.unit_price <> OLD.unit_price OR NEW.iva_rate <> OLD.iva_rate
       OR NEW.sort_order <> OLD.sort_order THEN
      RAISE EXCEPTION 'No se pueden cambiar ítems de una orden facturada' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND NEW.purchase_order_id <> OLD.purchase_order_id THEN
    RAISE EXCEPTION 'No se puede mover un ítem entre órdenes' USING ERRCODE = '23514';
  END IF;
  IF v_order.status = 'cancelled' THEN
    RAISE EXCEPTION 'No se pueden cambiar ítems de una orden cancelada' USING ERRCODE = '23514';
  END IF;
  IF NEW.product_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM products WHERE id = NEW.product_id AND company_id = v_order.company_id
      AND (provider_id IS NULL OR provider_id = v_order.provider_id)
  ) THEN
    RAISE EXCEPTION 'El producto no corresponde a la empresa y proveedor' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchase_order_items_validate BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_items
FOR EACH ROW EXECUTE FUNCTION purchase_order_item_validate();

CREATE FUNCTION purchase_order_allocation_validate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_order purchase_orders%ROWTYPE; v_invoice invoices%ROWTYPE;
v_order_total numeric(15,2); v_order_used numeric(15,2); v_invoice_used numeric(15,2);
v_old_order uuid; v_old_invoice uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.purchase_order_id <> OLD.purchase_order_id OR NEW.invoice_id <> OLD.invoice_id
       OR NEW.company_id <> OLD.company_id THEN
      RAISE EXCEPTION 'No se puede cambiar la identidad de una asignación' USING ERRCODE = '23514';
    END IF;
    v_old_order := OLD.purchase_order_id;
    v_old_invoice := OLD.invoice_id;
  END IF;
  -- Lock both parents before summing allocations, serializing concurrent writers.
  SELECT * INTO v_order FROM purchase_orders WHERE id = NEW.purchase_order_id FOR UPDATE;
  SELECT * INTO v_invoice FROM invoices WHERE id = NEW.invoice_id FOR UPDATE;
  IF v_order.id IS NULL OR v_invoice.id IS NULL OR v_order.company_id IS DISTINCT FROM NEW.company_id
     OR v_invoice.company_id IS DISTINCT FROM NEW.company_id
     OR v_order.provider_id IS DISTINCT FROM v_invoice.provider_id
     OR v_invoice.type <> 'payable' OR v_invoice.status = 'cancelled'
     OR v_order.status <> 'pending' THEN
    RAISE EXCEPTION 'Orden y factura incompatibles' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(line_total), 0) INTO v_order_total FROM purchase_order_items
    WHERE purchase_order_id = v_order.id;
  SELECT COALESCE(sum(allocated_amount), 0) INTO v_order_used FROM purchase_order_invoices
    WHERE purchase_order_id = v_order.id AND (purchase_order_id, invoice_id) IS DISTINCT FROM (v_old_order, v_old_invoice);
  SELECT COALESCE(sum(allocated_amount), 0) INTO v_invoice_used FROM purchase_order_invoices
    WHERE invoice_id = v_invoice.id AND (purchase_order_id, invoice_id) IS DISTINCT FROM (v_old_order, v_old_invoice);
  IF v_order_total <= 0 OR v_order_used + NEW.allocated_amount > v_order_total
     OR v_invoice_used + NEW.allocated_amount > COALESCE(v_invoice.total_amount, 0) THEN
    RAISE EXCEPTION 'El importe asignado supera el saldo de la orden o factura' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchase_order_allocations_validate BEFORE INSERT OR UPDATE ON purchase_order_invoices
FOR EACH ROW EXECUTE FUNCTION purchase_order_allocation_validate();

-- Existing invoices remain editable except for changes that would invalidate allocations.
CREATE FUNCTION purchase_order_invoice_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM purchase_order_invoices WHERE invoice_id = OLD.id) AND (
    NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.type <> 'payable' OR NEW.status = 'cancelled'
    OR COALESCE(NEW.total_amount, 0) < (SELECT sum(allocated_amount) FROM purchase_order_invoices WHERE invoice_id = OLD.id)
  ) THEN
    RAISE EXCEPTION 'La factura tiene órdenes de compra vinculadas' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchase_order_invoice_guard BEFORE UPDATE ON invoices
FOR EACH ROW EXECUTE FUNCTION purchase_order_invoice_guard();

CREATE VIEW purchase_order_progress WITH (security_invoker = true) AS
SELECT po.id, po.company_id, po.provider_id, po.user_id, po.order_number,
       po.issue_date, po.status, po.notes, po.created_at, po.updated_at,
       COALESCE(items.total_amount, 0)::numeric(15,2) AS total_amount,
       COALESCE(links.invoiced_amount, 0)::numeric(15,2) AS invoiced_amount,
       (COALESCE(items.total_amount, 0) - COALESCE(links.invoiced_amount, 0))::numeric(15,2) AS remaining_amount,
       CASE WHEN po.status = 'cancelled' THEN 'cancelled'
            WHEN po.status = 'draft' THEN 'draft'
            WHEN COALESCE(links.invoiced_amount, 0) = 0 THEN 'pending'
            WHEN COALESCE(links.invoiced_amount, 0) >= COALESCE(items.total_amount, 0) THEN 'invoiced'
            ELSE 'partially_invoiced' END AS billing_status
FROM purchase_orders po
LEFT JOIN (SELECT purchase_order_id, sum(line_total) total_amount FROM purchase_order_items GROUP BY 1) items ON items.purchase_order_id = po.id
LEFT JOIN (SELECT purchase_order_id, sum(allocated_amount) invoiced_amount FROM purchase_order_invoices GROUP BY 1) links ON links.purchase_order_id = po.id;

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_orders_select ON purchase_orders FOR SELECT USING (is_company_member(company_id));
CREATE POLICY purchase_orders_insert ON purchase_orders FOR INSERT WITH CHECK (can_write_company(company_id) AND user_id = auth.uid());
CREATE POLICY purchase_orders_update ON purchase_orders FOR UPDATE USING (can_write_company(company_id)) WITH CHECK (can_write_company(company_id));
CREATE POLICY purchase_orders_delete ON purchase_orders FOR DELETE USING (can_delete_company(company_id));
CREATE POLICY purchase_order_items_select ON purchase_order_items FOR SELECT USING (
  EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = purchase_order_id AND is_company_member(po.company_id)));
CREATE POLICY purchase_order_items_insert ON purchase_order_items FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = purchase_order_id AND can_write_company(po.company_id)));
CREATE POLICY purchase_order_items_update ON purchase_order_items FOR UPDATE USING (
  EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = purchase_order_id AND can_write_company(po.company_id))) WITH CHECK (
  EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = purchase_order_id AND can_write_company(po.company_id)));
CREATE POLICY purchase_order_items_delete ON purchase_order_items FOR DELETE USING (
  EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = purchase_order_id AND can_write_company(po.company_id)));
CREATE POLICY purchase_order_invoices_select ON purchase_order_invoices FOR SELECT USING (is_company_member(company_id));
CREATE POLICY purchase_order_invoices_insert ON purchase_order_invoices FOR INSERT WITH CHECK (can_write_company(company_id));
CREATE POLICY purchase_order_invoices_update ON purchase_order_invoices FOR UPDATE USING (can_write_company(company_id)) WITH CHECK (can_write_company(company_id));
CREATE POLICY purchase_order_invoices_delete ON purchase_order_invoices FOR DELETE USING (can_delete_company(company_id));

-- One database transaction for the header and its items. The caller's JWT and
-- the table RLS policies remain in force (SECURITY INVOKER is the default).
CREATE FUNCTION save_purchase_order(
  p_company_id uuid, p_order_id uuid, p_provider_id uuid, p_order_number text,
  p_issue_date date, p_status text, p_notes text, p_items jsonb
) RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_item jsonb; v_index integer := 0;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Los ítems deben ser una lista' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'La orden debe contener entre 1 y 100 ítems' USING ERRCODE = '23514';
  END IF;
  IF p_order_id IS NULL THEN
    INSERT INTO purchase_orders(company_id, provider_id, user_id, order_number, issue_date, status, notes)
    VALUES (p_company_id, p_provider_id, auth.uid(), p_order_number, p_issue_date, p_status, p_notes)
    RETURNING id INTO v_id;
  ELSE
    UPDATE purchase_orders SET provider_id = p_provider_id, order_number = p_order_number,
      issue_date = p_issue_date, status = p_status, notes = p_notes
    WHERE id = p_order_id AND company_id = p_company_id
      AND NOT EXISTS (SELECT 1 FROM purchase_order_invoices WHERE purchase_order_id = p_order_id)
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Orden no encontrada o ya facturada' USING ERRCODE = '23514'; END IF;
    DELETE FROM purchase_order_items WHERE purchase_order_id = v_id;
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO purchase_order_items(purchase_order_id, product_id, description, quantity, unit_price, iva_rate, sort_order)
    VALUES (v_id, NULLIF(v_item->>'product_id', '')::uuid, v_item->>'description',
      (v_item->>'quantity')::numeric, (v_item->>'unit_price')::numeric,
      COALESCE((v_item->>'iva_rate')::numeric, 0), v_index);
    v_index := v_index + 1;
  END LOOP;
  RETURN v_id;
END;
$$;

-- Inserts all order allocations for one supplier invoice atomically. The row
-- trigger verifies ownership, provider, payable type and both available sums.
CREATE FUNCTION allocate_purchase_orders(p_company_id uuid, p_invoice_id uuid, p_allocations jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_allocation jsonb;
BEGIN
  IF jsonb_typeof(p_allocations) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Las asignaciones deben ser una lista' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(p_allocations) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Seleccioná entre 1 y 100 órdenes' USING ERRCODE = '23514';
  END IF;
  FOR v_allocation IN SELECT value FROM jsonb_array_elements(p_allocations)
      ORDER BY value->>'purchase_order_id' LOOP
    INSERT INTO purchase_order_invoices(purchase_order_id, invoice_id, company_id, allocated_amount)
    VALUES ((v_allocation->>'purchase_order_id')::uuid, p_invoice_id, p_company_id,
      (v_allocation->>'allocated_amount')::numeric);
  END LOOP;
END;
$$;

-- Grouped invoice creation is fully atomic, including its lines and order
-- allocations. The invoice columns match the existing browser invoice flow.
CREATE FUNCTION create_grouped_purchase_invoice(
  p_company_id uuid, p_invoice jsonb, p_items jsonb, p_allocations jsonb
) RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_invoice jsonb; v_columns text; v_id uuid; v_item jsonb;
v_total numeric(15,2) := 0; v_allocated numeric(15,2); v_net_total numeric(15,2) := 0;
v_iva105 numeric(15,2) := 0; v_iva21 numeric(15,2) := 0; v_iva27 numeric(15,2) := 0;
v_net numeric(15,2); v_tax numeric(15,2);
v_rate numeric(5,2); v_index integer := 0; v_number text;
BEGIN
  IF jsonb_typeof(p_invoice) IS DISTINCT FROM 'object' OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Datos de factura agrupada inválidos' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 100
     OR (p_invoice->>'type') IS DISTINCT FROM 'payable'
     OR NULLIF(p_invoice->>'provider_id', '') IS NULL THEN
    RAISE EXCEPTION 'Datos de factura agrupada inválidos' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(p_allocations) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Seleccioná órdenes para la factura' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(p_allocations) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Seleccioná órdenes para la factura' USING ERRCODE = '23514';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF length(trim(COALESCE(v_item->>'description', ''))) = 0
       OR NULLIF(v_item->>'quantity', '') IS NULL OR NULLIF(v_item->>'unit_price', '') IS NULL
       OR (v_item->>'quantity')::numeric <= 0 OR (v_item->>'unit_price')::numeric <= 0 THEN
      RAISE EXCEPTION 'Ítem de factura inválido' USING ERRCODE = '23514';
    END IF;
    v_rate := COALESCE((v_item->>'alicuota_iva')::numeric, 0);
    IF v_rate NOT IN (0, 10.5, 21, 27) THEN
      RAISE EXCEPTION 'Alícuota de IVA inválida' USING ERRCODE = '23514';
    END IF;
    v_net := round((v_item->>'quantity')::numeric * (v_item->>'unit_price')::numeric, 2);
    v_tax := round(v_net * v_rate / 100, 2);
    v_total := v_total + v_net + v_tax;
    v_net_total := v_net_total + v_net;
    IF v_rate = 10.5 THEN v_iva105 := v_iva105 + v_tax;
    ELSIF v_rate = 21 THEN v_iva21 := v_iva21 + v_tax;
    ELSIF v_rate = 27 THEN v_iva27 := v_iva27 + v_tax;
    END IF;
  END LOOP;
  IF v_total <= 0 OR NULLIF(p_invoice->>'total_amount', '') IS NULL
     OR abs(v_total - (p_invoice->>'total_amount')::numeric) > 0.01 THEN
    RAISE EXCEPTION 'El total de la factura no coincide con sus ítems' USING ERRCODE = '23514';
  END IF;
  SELECT sum((value->>'allocated_amount')::numeric) INTO v_allocated FROM jsonb_array_elements(p_allocations);
  IF v_allocated IS NULL OR abs(v_total - v_allocated) > 0.01 THEN
    RAISE EXCEPTION 'La factura agrupada debe coincidir con los importes asignados' USING ERRCODE = '23514';
  END IF;
  IF COALESCE((p_invoice->>'punto_de_venta')::integer, 0) < 1
     OR COALESCE((p_invoice->>'numero_comprobante')::integer, 0) < 1 THEN
    RAISE EXCEPTION 'Número de factura inválido' USING ERRCODE = '23514';
  END IF;
  v_number := lpad((p_invoice->>'punto_de_venta')::integer::text,
    greatest(4, length((p_invoice->>'punto_de_venta')::integer::text)), '0') || '-' ||
    lpad((p_invoice->>'numero_comprobante')::integer::text,
    greatest(8, length((p_invoice->>'numero_comprobante')::integer::text)), '0');
  IF EXISTS (SELECT 1 FROM invoices WHERE company_id = p_company_id
      AND invoice_number = v_number AND tipo_comprobante = p_invoice->>'tipo_comprobante') THEN
    RAISE EXCEPTION 'Ya existe una factura con ese número y tipo' USING ERRCODE = '23505';
  END IF;
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO v_invoice
  FROM jsonb_each(p_invoice) WHERE key = ANY(ARRAY[
    'tipo_comprobante','type','punto_de_venta','numero_comprobante',
    'fecha_emision','fecha_vencimiento','condicion_pago','moneda','tipo_cambio',
    'pais_destino','emisor_cuit','emisor_razon_social','emisor_condicion_iva',
    'emisor_domicilio','receptor_id_impositivo','receptor_cuit',
    'receptor_razon_social','receptor_condicion_iva','receptor_domicilio',
    'neto_gravado','neto_no_gravado','exento','iva_105','iva_21','iva_27',
    'otros_tributos','total_amount','cae','cae_vencimiento','provider_id','notes'
  ]);
  v_invoice := v_invoice || jsonb_build_object('company_id', p_company_id,
    'user_id', auth.uid(), 'type', 'payable', 'invoice_number', v_number,
    'neto_gravado', v_net_total, 'neto_no_gravado', 0, 'exento', 0,
    'iva_105', v_iva105, 'iva_21', v_iva21, 'iva_27', v_iva27,
    'otros_tributos', 0, 'total_amount', v_total);
  SELECT string_agg(format('%I', key), ', ') INTO v_columns FROM jsonb_object_keys(v_invoice) AS key;
  EXECUTE format('INSERT INTO public.invoices (%1$s) SELECT %1$s FROM jsonb_populate_record(NULL::public.invoices, $1) RETURNING id', v_columns)
    INTO v_id USING v_invoice;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_rate := COALESCE((v_item->>'alicuota_iva')::numeric, 0);
    v_net := round((v_item->>'quantity')::numeric * (v_item->>'unit_price')::numeric, 2);
    v_tax := round(v_net * v_rate / 100, 2);
    INSERT INTO invoice_items(invoice_id, sort_order, description, quantity, unidad,
      unit_price, alicuota_iva, subtotal_neto, subtotal_iva)
    VALUES (v_id, v_index, v_item->>'description', (v_item->>'quantity')::numeric,
      v_item->>'unidad', (v_item->>'unit_price')::numeric, v_rate, v_net, v_tax);
    v_index := v_index + 1;
  END LOOP;
  PERFORM allocate_purchase_orders(p_company_id, v_id, p_allocations);
  RETURN v_id;
END;
$$;

REVOKE ALL ON purchase_orders, purchase_order_items, purchase_order_invoices, purchase_order_progress FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_orders, purchase_order_items, purchase_order_invoices TO authenticated;
GRANT SELECT ON purchase_order_progress TO authenticated;
REVOKE ALL ON FUNCTION save_purchase_order(uuid, uuid, uuid, text, date, text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION allocate_purchase_orders(uuid, uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION create_grouped_purchase_invoice(uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_purchase_order(uuid, uuid, uuid, text, date, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION allocate_purchase_orders(uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION create_grouped_purchase_invoice(uuid, jsonb, jsonb, jsonb) TO authenticated;
