CREATE TABLE IF NOT EXISTS holder_votes (
  mint TEXT NOT NULL,
  promise_idx INT NOT NULL,
  wallet TEXT NOT NULL,
  side TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mint, promise_idx, wallet)
);
