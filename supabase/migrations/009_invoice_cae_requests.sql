-- A reservation survives failed requests, process restarts and invoice deletion.
-- invoice_id also identifies drafts that have not been saved yet; it has no FK
-- to invoices for that reason. Only trusted server code may reserve or update it.
BEGIN;

CREATE TABLE public.invoice_cae_requests (
  invoice_id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  state text NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'authorized', 'rejected', 'unknown')),
  arca_request jsonb,
  arca_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.invoice_cae_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_cae_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.invoice_cae_requests TO service_role;

CREATE FUNCTION public.reserve_invoice_cae(
  p_invoice_id uuid, p_company_id uuid, p_user_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_invoice public.invoices%ROWTYPE;
BEGIN
  IF p_invoice_id IS NULL OR p_company_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'invoice.id, company_id y usuario son requeridos'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.companies c
    WHERE c.id = p_company_id AND (
      c.owner_id = p_user_id OR EXISTS (
        SELECT 1 FROM public.user_roles r
        WHERE r.company_id = c.id AND r.user_id = p_user_id
          AND r.role IN ('admin', 'accountant')
      )
    )
  ) THEN
    RAISE EXCEPTION 'No tenés permisos para emitir en esta empresa'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_invoice FROM public.invoices
    WHERE id = p_invoice_id FOR UPDATE;
  IF FOUND THEN
    IF v_invoice.company_id IS DISTINCT FROM p_company_id THEN
      RAISE EXCEPTION 'La factura no pertenece a esta empresa'
        USING ERRCODE = '42501';
    END IF;
    IF v_invoice.type IS DISTINCT FROM 'receivable' THEN
      RAISE EXCEPTION 'Solo se pueden emitir facturas de venta'
        USING ERRCODE = '22023';
    END IF;
    IF nullif(trim(v_invoice.cae), '') IS NOT NULL
       OR v_invoice.afip_status IN ('issued', 'authorized', 'valid') THEN
      RAISE EXCEPTION 'Esta factura ya tiene un CAE. No se puede solicitar otro.'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  INSERT INTO public.invoice_cae_requests (invoice_id, company_id, user_id)
    VALUES (p_invoice_id, p_company_id, p_user_id)
    ON CONFLICT (invoice_id) DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El CAE de esta factura ya fue solicitado. No se puede volver a solicitar; consultá el resultado del intento anterior.'
      USING ERRCODE = '23505';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_invoice_cae(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_invoice_cae(uuid, uuid, uuid)
  TO service_role;

COMMIT;
