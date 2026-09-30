-- Proof of Ship core schema

CREATE TABLE IF NOT EXISTS builders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet TEXT NOT NULL UNIQUE,
  x_handle TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  mint TEXT PRIMARY KEY,
  builder_id UUID NOT NULL REFERENCES builders (id),
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL,
  state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_builder_idx ON projects (builder_id);
CREATE INDEX IF NOT EXISTS projects_status_idx ON projects (status);

CREATE TABLE IF NOT EXISTS feed_events (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  at_ms BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feed_events_created_idx ON feed_events (id DESC);
CREATE INDEX IF NOT EXISTS feed_events_mint_idx ON feed_events (mint);
