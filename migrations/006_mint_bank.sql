CREATE TABLE IF NOT EXISTS mint_bank (
  public_key TEXT PRIMARY KEY,
  secret_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  reserved_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status IN ('ready', 'reserved', 'used')),
  CHECK (public_key LIKE '%PoS')
);

CREATE INDEX IF NOT EXISTS mint_bank_ready_idx
  ON mint_bank (created_at)
  WHERE status = 'ready';
