CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('github', 'google')),
  provider_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_id)
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('commander', 'modern', 'standard')),
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deck_cards (
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
  zone TEXT NOT NULL CHECK (zone IN ('commander', 'mainboard', 'sideboard')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (deck_id, card_id, zone)
);

CREATE INDEX IF NOT EXISTS deck_cards_card_id_idx ON deck_cards(card_id);
CREATE INDEX IF NOT EXISTS decks_updated_at_idx ON decks(updated_at DESC);
CREATE INDEX IF NOT EXISTS decks_user_id_idx ON decks(user_id);

ALTER TABLE decks
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
