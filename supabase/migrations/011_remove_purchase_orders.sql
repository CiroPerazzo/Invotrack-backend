-- Elimina el modulo de ordenes de compra y sus datos en todas las empresas.
-- Conserva invoices, invoice_items, invoice_payments, providers y products.
-- Ejecutar en el SQL Editor de Supabase despues de desplegar la aplicacion.
BEGIN;

DROP TRIGGER IF EXISTS purchase_order_invoice_guard ON public.invoices;
DROP FUNCTION IF EXISTS public.purchase_order_invoice_guard();
DROP FUNCTION IF EXISTS public.create_grouped_purchase_invoice(uuid, jsonb, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.allocate_purchase_orders(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.save_purchase_order(uuid, uuid, uuid, text, date, text, text, jsonb);

DROP VIEW IF EXISTS public.purchase_order_progress;
DROP TABLE IF EXISTS public.purchase_order_invoices;
DROP TABLE IF EXISTS public.purchase_order_items;
DROP TABLE IF EXISTS public.purchase_orders;

DROP FUNCTION IF EXISTS public.purchase_order_allocation_validate();
DROP FUNCTION IF EXISTS public.purchase_order_item_validate();
DROP FUNCTION IF EXISTS public.purchase_order_validate();
DROP INDEX IF EXISTS public.providers_id_company_unique_for_purchase_orders;
DROP INDEX IF EXISTS public.invoices_id_company_unique_for_purchase_orders;

COMMIT;
