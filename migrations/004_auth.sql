CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_sessions_wallet_idx ON auth_sessions (wallet);

CREATE TABLE IF NOT EXISTS x_links (
  wallet TEXT PRIMARY KEY,
  x_user_id TEXT NOT NULL UNIQUE,
  x_handle TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
