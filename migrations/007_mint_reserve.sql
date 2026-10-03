ALTER TABLE mint_bank ADD COLUMN IF NOT EXISTS reserved_wallet TEXT;

CREATE INDEX IF NOT EXISTS mint_bank_reserved_wallet_idx
  ON mint_bank (reserved_wallet)
  WHERE status = 'reserved';
