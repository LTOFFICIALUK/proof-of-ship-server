CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  body TEXT NOT NULL,
  at_ms BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_mint_idx ON chat_messages (mint, id);
