-- ============================================================
-- 006 — Ficha fiscal de la empresa
-- ============================================================
-- El emisor de un comprobante necesita identidad fiscal completa
-- (razón social, CUIT, condición IVA, domicilio, contacto).
-- Antes esos datos se tipeaban en cada factura; ahora se cargan
-- una vez en el onboarding y se autocompletan al crear el comprobante.
--
-- No se toca RLS: las columnas heredan las políticas de `companies`
-- (propietario con acceso total + miembros con rol para lectura).
-- ============================================================

ALTER TABLE companies
  -- Qué clase de emisor es: persona humana o empresa.
  -- Define qué campos pide el onboarding y cómo se titulan.
  ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'empresa'
    CHECK (entity_type IN ('persona_humana', 'empresa')),

  -- Actividad principal según el nomenclador de ARCA (ej: "620100 - Programación").
  ADD COLUMN IF NOT EXISTS activity TEXT,

  -- Domicilio fiscal desglosado. `address` se mantiene como línea única
  -- compuesta a partir de estas partes (ver buildCompanyAddress en el front).
  ADD COLUMN IF NOT EXISTS street TEXT,
  ADD COLUMN IF NOT EXISTS street_number TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS province TEXT,

  -- Contacto
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,

  -- Punto de venta por defecto para la numeración propia de comprobantes.
  ADD COLUMN IF NOT EXISTS default_sale_point INTEGER DEFAULT 1;

-- Backfill: las empresas creadas antes de esta migración son empresas.
UPDATE companies SET entity_type = 'empresa' WHERE entity_type IS NULL;

-- companies no tenía trigger de updated_at (solo invoices/clients/providers).
DROP TRIGGER IF EXISTS companies_updated_at ON companies;
CREATE TRIGGER companies_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
