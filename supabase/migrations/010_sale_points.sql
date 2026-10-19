-- Puntos de venta de cada empresa. Requiere las funciones de permisos de
-- 001_rls_company_isolation.sql. No depende de la migración 009 de CAE.
-- Los registros locales no dan de alta puntos de venta fiscales en ARCA.
BEGIN;

CREATE TABLE public.sale_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number BETWEEN 1 AND 99998),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  address text NOT NULL CHECK (length(trim(address)) BETWEEN 1 AND 500),
  environment text NOT NULL DEFAULT 'testing'
    CHECK (environment IN ('testing', 'production')),
  billing_system text NOT NULL DEFAULT 'web_services'
    CHECK (billing_system = 'web_services'),
  active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sale_points_company_environment_number_key
    UNIQUE (company_id, environment, number),
  CONSTRAINT sale_points_default_must_be_active CHECK (NOT is_default OR active)
);

-- Cada empresa puede elegir un predeterminado distinto en cada ambiente.
CREATE UNIQUE INDEX sale_points_one_default_per_company_environment
  ON public.sale_points (company_id, environment) WHERE is_default;

COMMENT ON COLUMN public.sale_points.number IS
  'Número fiscal entero; mostrar con cinco dígitos (por ejemplo, 3 como 00003).';
COMMENT ON COLUMN public.sale_points.environment IS
  'testing = homologación; production = producción. El backend elige el ambiente.';

CREATE FUNCTION public.sale_points_stamp_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER sale_points_updated_at BEFORE UPDATE ON public.sale_points
  FOR EACH ROW EXECUTE FUNCTION public.sale_points_stamp_update();

ALTER TABLE public.sale_points ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sale_points FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sale_points TO authenticated;
GRANT ALL ON public.sale_points TO service_role;

CREATE POLICY sale_points_select ON public.sale_points
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
CREATE POLICY sale_points_insert ON public.sale_points
  FOR INSERT TO authenticated WITH CHECK (public.can_write_company(company_id));
CREATE POLICY sale_points_update ON public.sale_points
  FOR UPDATE TO authenticated USING (public.can_write_company(company_id))
  WITH CHECK (public.can_write_company(company_id));
CREATE POLICY sale_points_delete ON public.sale_points
  FOR DELETE TO authenticated USING (public.can_delete_company(company_id));

-- Cambia el predeterminado en una transacción sin dejar dos seleccionados.
-- Usa la sesión del usuario y RLS; no recibe un user_id desde el cliente.
CREATE FUNCTION public.set_default_sale_point(
  p_company_id uuid, p_sale_point_id uuid, p_environment text DEFAULT 'testing'
) RETURNS public.sale_points
LANGUAGE plpgsql
SECURITY INVOKER
-- Las funciones de permisos existentes usan nombres de tabla sin esquema.
SET search_path = public, pg_temp
AS $$
DECLARE
  v_point public.sale_points%ROWTYPE;
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('testing', 'production') THEN
    RAISE EXCEPTION 'Ambiente inválido' USING ERRCODE = '22023';
  END IF;
  IF p_company_id IS NULL OR NOT public.can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'No tenés permisos para modificar puntos de venta de esta empresa'
      USING ERRCODE = '42501';
  END IF;

  -- Serializa cambios del predeterminado sin requerir permiso para editar
  -- companies (un accountant puede administrar puntos de venta).
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':' || p_environment, 0)
  );
  SELECT * INTO v_point FROM public.sale_points
    WHERE id = p_sale_point_id AND company_id = p_company_id
      AND environment = p_environment FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Punto de venta no encontrado en esta empresa y ambiente'
      USING ERRCODE = '22023';
  END IF;
  IF NOT v_point.active THEN
    RAISE EXCEPTION 'El punto de venta predeterminado debe estar activo'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.sale_points SET is_default = false
    WHERE company_id = p_company_id AND environment = p_environment AND is_default;
  UPDATE public.sale_points SET is_default = true
    WHERE id = p_sale_point_id AND company_id = p_company_id
      AND environment = p_environment RETURNING * INTO v_point;
  RETURN v_point;
END;
$$;

REVOKE ALL ON FUNCTION public.set_default_sale_point(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_default_sale_point(uuid, uuid, text)
  TO authenticated;

COMMIT;
