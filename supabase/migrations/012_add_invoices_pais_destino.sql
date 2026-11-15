-- País de destino para comprobantes de exportación (Factura E / exportación).
-- El formulario de facturas y el flujo OCR envían `pais_destino`, pero la
-- columna nunca se agregó a la tabla invoices. Sin ella PostgREST responde:
--   Could not find the 'pais_destino' column of 'invoices' in the schema cache
BEGIN;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS pais_destino TEXT;

-- Recarga la caché de esquema de PostgREST para que la columna quede
-- disponible sin reiniciar el proyecto de Supabase.
NOTIFY pgrst, 'reload schema';

COMMIT;
