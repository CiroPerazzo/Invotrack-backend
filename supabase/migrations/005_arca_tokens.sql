-- ============================================================
-- ARCA - Caché compartida de Ticket de Acceso (TA)
-- Las edge functions son stateless: el TA (token+sign) se guarda
-- acá para que todas las invocaciones reutilicen el mismo ticket
-- y no se generen TAs huérfanos (coe.alreadyAuthenticated).
-- Solo accesible por service_role (RLS sin políticas).
-- ============================================================
CREATE TABLE IF NOT EXISTS arca_tokens (
  service TEXT NOT NULL,
  cuit TEXT NOT NULL,
  token TEXT NOT NULL,
  sign TEXT NOT NULL,
  generation_time TIMESTAMPTZ,
  expiration_time TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (service, cuit)
);

ALTER TABLE arca_tokens ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_arca_tokens_expiration ON arca_tokens(expiration_time);

-- PostgreSQL no soporta CREATE TRIGGER IF NOT EXISTS; se usa DROP + CREATE.
DROP TRIGGER IF EXISTS arca_tokens_updated_at ON arca_tokens;
CREATE TRIGGER arca_tokens_updated_at BEFORE UPDATE ON arca_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
