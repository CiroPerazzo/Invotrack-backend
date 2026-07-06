-- ============================================================
-- ADD STOCK COLUMN TO PRODUCTS
-- ============================================================
-- Agrega columna stock para control de inventario.
-- Se actualiza automáticamente al crear facturas de compra/venta.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock NUMERIC(10, 2) NOT NULL DEFAULT 0;
