-- Agrega el vínculo producto → proveedor.
-- El proveedor es al que se le compra el producto.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS provider_id UUID REFERENCES providers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_products_provider_id ON products(provider_id);
