-- ==============================================================================
-- ArcaneForge MTG Deckbuilder: Relational 3NF + JSONB Database Schema
-- Optimized for PostgreSQL on Neon (Serverless Cloud Postgres)
-- ==============================================================================

-- 1. Enable pgcrypto for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Table: users (Player Accounts & Profiles)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(64) UNIQUE,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT,
  display_name VARCHAR(120),
  avatar_url TEXT,
  provider VARCHAR(32) DEFAULT 'local',
  provider_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Table: cards (Local Scryfall Card Cache: 3NF Relational Columns + JSONB)
-- Zero data duplication: card metadata is stored once even if included in 1,000 decks.
CREATE TABLE IF NOT EXISTS cards (
  scryfall_id TEXT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  mana_cost VARCHAR(64),
  cmc NUMERIC(5, 1) DEFAULT 0,
  type_line VARCHAR(255),
  color_identity TEXT[] DEFAULT '{}',
  image_uris JSONB DEFAULT '{}'::jsonb,
  prices JSONB DEFAULT '{}'::jsonb,
  legalities JSONB DEFAULT '{}'::jsonb,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure all columns exist in case of incremental schema updates
ALTER TABLE cards ADD COLUMN IF NOT EXISTS scryfall_id TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS mana_cost VARCHAR(64);
ALTER TABLE cards ADD COLUMN IF NOT EXISTS cmc NUMERIC(5, 1) DEFAULT 0;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS type_line VARCHAR(255);
ALTER TABLE cards ADD COLUMN IF NOT EXISTS color_identity TEXT[] DEFAULT '{}';
ALTER TABLE cards ADD COLUMN IF NOT EXISTS image_uris JSONB DEFAULT '{}'::jsonb;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS prices JSONB DEFAULT '{}'::jsonb;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS legalities JSONB DEFAULT '{}'::jsonb;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS data JSONB DEFAULT '{}'::jsonb;

-- 4. Table: decks (Deck Metadata)
CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  format VARCHAR(32) NOT NULL DEFAULT 'commander',
  description TEXT DEFAULT '',
  commander_card_id TEXT REFERENCES cards(scryfall_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Table: deck_cards (Many-to-Many Relational Join Table)
-- Links decks to cards with zone (commander, mainboard, sideboard) and quantity.
CREATE TABLE IF NOT EXISTS deck_cards (
  id SERIAL PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(scryfall_id) ON DELETE RESTRICT,
  zone VARCHAR(32) NOT NULL CHECK (zone IN ('commander', 'mainboard', 'sideboard')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  UNIQUE (deck_id, card_id, zone)
);

-- 6. Indexes for High-Speed Joins & Lookups
CREATE INDEX IF NOT EXISTS deck_cards_deck_id_idx ON deck_cards(deck_id);
CREATE INDEX IF NOT EXISTS deck_cards_card_id_idx ON deck_cards(card_id);
CREATE INDEX IF NOT EXISTS decks_user_id_idx ON decks(user_id);
CREATE INDEX IF NOT EXISTS decks_updated_at_idx ON decks(updated_at DESC);
CREATE INDEX IF NOT EXISTS cards_name_idx ON cards(name);

-- 7. Seed Default Student Demo User
INSERT INTO users (id, username, email, display_name)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'student_demo',
  'student@arcaneforge.edu',
  'Student Deckbuilder (Neon Cloud)'
)
ON CONFLICT (id) DO NOTHING;

-- ==============================================================================
-- USEFUL QUERIES FOR NEON SQL EDITOR (GREAT FOR PRESENTATIONS & PROFESSOR GRADING)
-- ==============================================================================

-- Query A: Inspect all saved decks with total card counts
-- SELECT d.id, d.name, d.format, d.created_at, SUM(dc.quantity) AS total_cards
-- FROM decks d
-- LEFT JOIN deck_cards dc ON dc.deck_id = d.id
-- GROUP BY d.id;

-- Query B: Inspect the many-to-many join showing cards inside each deck
-- SELECT d.name AS deck_name, dc.zone, dc.quantity, c.name AS card_name, c.mana_cost, c.cmc
-- FROM deck_cards dc
-- JOIN decks d ON d.id = dc.deck_id
-- JOIN cards c ON c.scryfall_id = dc.card_id
-- ORDER BY d.name, dc.zone, c.name;

-- Query C: Most popular cards across all decks (aggregating the join table)
-- SELECT c.name, COUNT(DISTINCT dc.deck_id) AS deck_count, SUM(dc.quantity) AS total_copies
-- FROM deck_cards dc
-- JOIN cards c ON c.scryfall_id = dc.card_id
-- GROUP BY c.name
-- ORDER BY deck_count DESC, total_copies DESC;

-- Query D: Average Mana Value (CMC) per deck
-- SELECT d.name, ROUND(AVG(c.cmc), 2) AS avg_cmc
-- FROM deck_cards dc
-- JOIN decks d ON d.id = dc.deck_id
-- JOIN cards c ON c.scryfall_id = dc.card_id
-- WHERE c.type_line NOT LIKE '%Land%'
-- GROUP BY d.id;
