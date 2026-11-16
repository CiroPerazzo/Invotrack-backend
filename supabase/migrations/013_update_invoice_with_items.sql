-- Save the header and detail in one transaction. RLS remains in force.
CREATE OR REPLACE FUNCTION public.update_invoice_with_items(
  p_invoice_id uuid, p_company_id uuid, p_updates jsonb, p_items jsonb DEFAULT NULL
) RETURNS public.invoices
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  v_invoice public.invoices;
  v_updates jsonb;
  v_assignments text;
  v_item jsonb;
  v_row jsonb;
  v_columns text;
  v_index integer := 0;
BEGIN
  SELECT * INTO v_invoice FROM public.invoices
    WHERE id = p_invoice_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Factura no encontrada o sin permisos';
  END IF;
  IF jsonb_typeof(p_updates) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Datos de factura invalidos';
  END IF;
  v_updates := p_updates - ARRAY['id', 'company_id', 'user_id', 'created_at',
    'updated_at', 'items', 'invoice_items', 'consumidor_final_anonimo'];
  SELECT string_agg(format('%1$I = r.%1$I', key), ', ')
    INTO v_assignments FROM jsonb_object_keys(v_updates) AS key;
  IF v_assignments IS NOT NULL THEN
    EXECUTE format('UPDATE public.invoices AS i SET %s
      FROM jsonb_populate_record(NULL::public.invoices, $1) AS r
      WHERE i.id = $2 AND i.company_id = $3 RETURNING i.*', v_assignments)
      INTO v_invoice USING v_updates, p_invoice_id, p_company_id;
    IF v_invoice.id IS NULL THEN
      RAISE EXCEPTION 'Sin permisos para actualizar la factura';
    END IF;
  END IF;
  IF p_items IS NOT NULL THEN
    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Items invalidos';
    END IF;
    DELETE FROM public.invoice_items WHERE invoice_id = p_invoice_id;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
      -- Support the original schema and the fiscal field names used by the form.
      v_row := jsonb_build_object(
        'invoice_id', p_invoice_id, 'sort_order', v_index,
        'description', COALESCE(v_item->>'description', v_item->>'descripcion', ''),
        'quantity', COALESCE(v_item->'quantity', v_item->'cantidad', '1'::jsonb),
        'unit_price', COALESCE(v_item->'unit_price', v_item->'precio_unitario', '0'::jsonb),
        'unidad', v_item->>'unidad',
        'iva_rate', COALESCE(v_item->'alicuota_iva', v_item->'iva_rate', '0'::jsonb),
        'alicuota_iva', COALESCE(v_item->'alicuota_iva', v_item->'iva_rate', '0'::jsonb),
        'subtotal', COALESCE(v_item->'subtotal_neto', '0'::jsonb),
        'subtotal_neto', COALESCE(v_item->'subtotal_neto', '0'::jsonb),
        'subtotal_iva', COALESCE(v_item->'subtotal_iva', '0'::jsonb));
      SELECT string_agg(format('%I', key), ', ') INTO v_columns
        FROM jsonb_object_keys(v_row) AS key
        WHERE EXISTS (SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema = 'public' AND c.table_name = 'invoice_items' AND c.column_name = key);
      EXECUTE format('INSERT INTO public.invoice_items (%1$s)
        SELECT %1$s FROM jsonb_populate_record(NULL::public.invoice_items, $1)', v_columns)
        USING v_row;
      v_index := v_index + 1;
    END LOOP;
  END IF;
  RETURN v_invoice;
END;
$$;
REVOKE ALL ON FUNCTION public.update_invoice_with_items(uuid, uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_invoice_with_items(uuid, uuid, jsonb, jsonb) TO authenticated;
NOTIFY pgrst, 'reload schema';
