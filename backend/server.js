import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from backend/.env first, then root .env as fallback
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
// Default to 3001 to align with Vite's dev proxy (/api -> http://localhost:3001)
const PORT = Number(process.env.PORT || 3001);

// Middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Default demo user ID for out-of-the-box local testing & grading presentations
const DEMO_USER_ID = 'a0000000-0000-0000-0000-000000000001';
const DEMO_USER = {
  id: DEMO_USER_ID,
  username: 'student_demo',
  email: 'student@arcaneforge.edu',
  display_name: 'Student Deckbuilder (Neon Cloud)'
};

// ============================================================================
// 1. POSTGRESQL CONNECTION POOL (NEON SERVERLESS CLOUD)
// ============================================================================
let pool = null;
let isDbConnected = false;

if (process.env.DATABASE_URL) {
  const isLocalDb =
    process.env.DATABASE_URL.includes('localhost') ||
    process.env.DATABASE_URL.includes('127.0.0.1');

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocalDb ? false : { rejectUnauthorized: false }
  });

  pool.on('error', (err) => {
    console.error('Unexpected error on idle PostgreSQL client:', err);
  });
} else {
  console.warn('⚠️  DATABASE_URL is not set. Operating in fallback mode (JSON file store).');
  console.warn('👉 Add your Neon connection string to backend/.env to enable PostgreSQL.');
}

// ============================================================================
// 2. AUTOMATIC SCHEMA CREATION (ON STARTUP)
// ============================================================================
async function initDatabase() {
  if (!pool) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Enable pgcrypto for UUID generation if supported
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
    } catch {
      // pgcrypto may already be enabled or restricted by cloud role; continue safely
    }

    // Table 1: users (Player accounts)
    await client.query(`
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
    `);

    // Table 2: cards (Scryfall Card Cache — Relational Columns + JSONB)
    await client.query(`
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
    `);

    // Compatibility check: ensure all columns exist if table was previously created
    await client.query(`
      ALTER TABLE cards ADD COLUMN IF NOT EXISTS scryfall_id TEXT;
      ALTER TABLE cards ADD COLUMN IF NOT EXISTS mana_cost VARCHAR(64);
      ALTER TABLE cards ADD COLUMN IF NOT EXISTS cmc NUMERIC(5, 1) DEFAULT 0;
      ALTER TABLE cards ADD COLUMN IF NOT EXISTS type_line VARCHAR(255);
      ALTER TABLE cards ADD COLUMN IF NOT EXISTS color_identity TEXT[] DEFAULT '{}';
      ALTER TABLE cards ADD COLUMN IF NOT EXISTS image_uris JSONB DEFAULT '{}'::jsonb;
      ALTER TABLE cards ADD COLUMN IF NOT EXISTS prices JSONB DEFAULT '{}'::jsonb;
      ALTER TABLE cards ADD COLUMN IF NOT EXISTS legalities JSONB DEFAULT '{}'::jsonb;
      ALTER TABLE cards ADD COLUMN IF NOT EXISTS data JSONB DEFAULT '{}'::jsonb;
    `);

    // Table 3: decks (Deck Metadata)
    await client.query(`
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
    `);

    // Table 4: deck_cards (Many-to-Many Join Table)
    await client.query(`
      CREATE TABLE IF NOT EXISTS deck_cards (
        id SERIAL PRIMARY KEY,
        deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        card_id TEXT NOT NULL REFERENCES cards(scryfall_id) ON DELETE RESTRICT,
        zone VARCHAR(32) NOT NULL CHECK (zone IN ('commander', 'mainboard', 'sideboard')),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        UNIQUE (deck_id, card_id, zone)
      );
    `);

    // Relational Performance Indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS deck_cards_deck_id_idx ON deck_cards(deck_id);
      CREATE INDEX IF NOT EXISTS deck_cards_card_id_idx ON deck_cards(card_id);
      CREATE INDEX IF NOT EXISTS decks_user_id_idx ON decks(user_id);
      CREATE INDEX IF NOT EXISTS decks_updated_at_idx ON decks(updated_at DESC);
      CREATE INDEX IF NOT EXISTS cards_name_idx ON cards(name);
    `);

    // Seed default student demo account
    await client.query(`
      INSERT INTO users (id, username, email, display_name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO NOTHING;
    `, [DEMO_USER.id, DEMO_USER.username, DEMO_USER.email, DEMO_USER.display_name]);

    await client.query('COMMIT');
    isDbConnected = true;
    console.log('✅ PostgreSQL Schema initialized on Neon: users, cards, decks, deck_cards ready!');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Database schema initialization error:', error.message);
  } finally {
    client.release();
  }
}

// ============================================================================
// 3. FILE-BASED FALLBACK STORAGE (Used only if DATABASE_URL is not set)
// ============================================================================
const DATA_DIR = path.join(__dirname, 'data');
const DECKS_FILE = path.join(DATA_DIR, 'decks.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readDecksFromDisk() {
  try {
    if (!fs.existsSync(DECKS_FILE)) {
      fs.writeFileSync(DECKS_FILE, JSON.stringify([], null, 2));
      return [];
    }
    const raw = fs.readFileSync(DECKS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading decks.json:', err);
    return [];
  }
}

function writeDecksToDisk(decks) {
  fs.writeFileSync(DECKS_FILE, JSON.stringify(decks, null, 2));
}

// ============================================================================
// 4. POSTGRESQL RELATIONAL DECK QUERIES
// ============================================================================
function normalizeDeck(deck) {
  return {
    id: String(deck.id),
    name: deck.name,
    format: deck.format || 'commander',
    description: deck.description || '',
    entries: Array.isArray(deck.entries)
      ? deck.entries.map((entry) => ({
          card: entry.card,
          quantity: Number(entry.quantity) || 1,
          zone: entry.zone || 'mainboard'
        }))
      : []
  };
}

async function readDecksFromPostgres(userId = null) {
  const { rows } = await pool.query(
    `SELECT
       d.id,
       d.name,
       d.format,
       d.description,
       d.commander_card_id,
       d.created_at,
       d.updated_at,
       COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'card', CASE
                       WHEN c.data IS NOT NULL AND c.data != '{}'::jsonb THEN c.data
                       ELSE jsonb_build_object(
                         'id', c.scryfall_id,
                         'name', c.name,
                         'mana_cost', c.mana_cost,
                         'cmc', c.cmc,
                         'type_line', c.type_line,
                         'color_identity', c.color_identity,
                         'image_uris', c.image_uris,
                         'prices', c.prices,
                         'legalities', c.legalities
                       )
                     END,
             'quantity', dc.quantity,
             'zone', dc.zone
           )
           ORDER BY dc.zone, c.name
         ) FILTER (WHERE dc.card_id IS NOT NULL),
         '[]'::jsonb
       ) AS entries
     FROM decks d
     LEFT JOIN deck_cards dc ON dc.deck_id = d.id
     LEFT JOIN cards c ON c.scryfall_id = dc.card_id
     WHERE ($1::uuid IS NULL OR d.user_id = $1::uuid OR d.user_id IS NULL)
     GROUP BY d.id
     ORDER BY d.updated_at DESC`,
    [userId]
  );

  return rows.map(normalizeDeck);
}

async function saveDeckToPostgres(deck, userId = DEMO_USER_ID) {
  const normalized = normalizeDeck(deck);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Upsert all cards in this deck into the `cards` table cache
    for (const entry of normalized.entries) {
      if (!entry.card || !entry.card.name) continue;

      const scryfallId = String(entry.card.id || entry.card.scryfall_id || entry.card.name);
      const name = entry.card.name;
      const manaCost = entry.card.mana_cost || null;
      const cmc = typeof entry.card.cmc === 'number' ? entry.card.cmc : (parseFloat(entry.card.cmc) || 0);
      const typeLine = entry.card.type_line || null;
      const colorIdentity = Array.isArray(entry.card.color_identity) ? entry.card.color_identity : [];
      const imageUris = entry.card.image_uris || (entry.card.card_faces?.[0]?.image_uris) || {};
      const prices = entry.card.prices || {};
      const legalities = entry.card.legalities || {};
      const fullData = { ...entry.card, id: scryfallId };

      await client.query(
        `INSERT INTO cards (
           scryfall_id, name, mana_cost, cmc, type_line, color_identity, image_uris, prices, legalities, data, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, NOW())
         ON CONFLICT (scryfall_id) DO UPDATE SET
           name = EXCLUDED.name,
           mana_cost = EXCLUDED.mana_cost,
           cmc = EXCLUDED.cmc,
           type_line = EXCLUDED.type_line,
           color_identity = EXCLUDED.color_identity,
           image_uris = EXCLUDED.image_uris,
           prices = EXCLUDED.prices,
           legalities = EXCLUDED.legalities,
           data = EXCLUDED.data,
           updated_at = NOW()`,
        [
          scryfallId,
          name,
          manaCost,
          cmc,
          typeLine,
          colorIdentity,
          JSON.stringify(imageUris),
          JSON.stringify(prices),
          JSON.stringify(legalities),
          JSON.stringify(fullData)
        ]
      );
    }

    // 2. Identify designated commander card if any
    const commanderEntry = normalized.entries.find((e) => e.zone === 'commander');
    const commanderCardId = commanderEntry
      ? String(commanderEntry.card.id || commanderEntry.card.scryfall_id || commanderEntry.card.name)
      : null;

    // 3. Upsert deck metadata in `decks`
    await client.query(
      `INSERT INTO decks (id, user_id, name, format, description, commander_card_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (id) DO UPDATE SET
         user_id = COALESCE(EXCLUDED.user_id, decks.user_id),
         name = EXCLUDED.name,
         format = EXCLUDED.format,
         description = EXCLUDED.description,
         commander_card_id = EXCLUDED.commander_card_id,
         updated_at = NOW()`,
      [
        normalized.id,
        userId,
        normalized.name,
        normalized.format,
        normalized.description,
        commanderCardId
      ]
    );

    // 4. Overwrite deck_cards entries for this deck
    await client.query('DELETE FROM deck_cards WHERE deck_id = $1', [normalized.id]);

    for (const entry of normalized.entries) {
      if (!entry.card || !entry.card.name || entry.quantity < 1) continue;
      const cardId = String(entry.card.id || entry.card.scryfall_id || entry.card.name);

      await client.query(
        `INSERT INTO deck_cards (deck_id, card_id, zone, quantity)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (deck_id, card_id, zone) DO UPDATE SET
           quantity = EXCLUDED.quantity`,
        [normalized.id, cardId, entry.zone || 'mainboard', entry.quantity || 1]
      );
    }

    await client.query('COMMIT');
    return normalized;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Failed to save deck to PostgreSQL:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function deleteDeckFromPostgres(deckId) {
  // ON DELETE CASCADE automatically removes join rows in deck_cards
  const result = await pool.query('DELETE FROM decks WHERE id = $1', [deckId]);
  return result.rowCount > 0;
}

// ============================================================================
// 5. IN-MEMORY SCRYFALL SEARCH CACHE (Speeds up queries & prevents 429s)
// ============================================================================
const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes

const BASIC_LANDS = new Set([
  'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes',
  'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp',
  'Snow-Covered Mountain', 'Snow-Covered Forest'
]);

// ============================================================================
// 6. CORE API ENDPOINTS
// ============================================================================

// Welcome route
app.get('/', (_req, res) => {
  res.json({
    message: 'Welcome to the ArcaneForge MTG Deckbuilder Backend API',
    database: pool ? 'PostgreSQL (Neon Cloud)' : 'Local File Store',
    endpoints: {
      health: 'GET /api/health',
      user: 'GET /api/me',
      searchCards: 'GET /api/cards/search?q=sol+ring',
      decks: 'GET /api/decks',
      saveDeck: 'PUT /api/decks/:id or POST /api/decks',
      deleteDeck: 'DELETE /api/decks/:id',
      validateDeck: 'POST /api/decks/validate',
      parseArenaText: 'POST /api/decks/parse'
    }
  });
});

// Health check & database metrics endpoint
app.get('/api/health', async (_req, res) => {
  if (pool) {
    try {
      const client = await pool.connect();
      try {
        const [deckCountRes, cardCountRes] = await Promise.all([
          client.query('SELECT COUNT(*)::int AS count FROM decks'),
          client.query('SELECT COUNT(*)::int AS count FROM cards')
        ]);

        return res.json({
          ok: true,
          status: 'online',
          dbConnected: isDbConnected,
          service: 'ArcaneForge MTG Deckbuilder API',
          storageMode: 'PostgreSQL (Neon Serverless Cloud)',
          tables: ['users', 'cards', 'decks', 'deck_cards'],
          savedDecksCount: deckCountRes.rows[0].count,
          cachedCardsCount: cardCountRes.rows[0].count,
          cachedSearchQueries: searchCache.size,
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString()
        });
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Database query failed in /api/health:', err.message);
      return res.status(503).json({
        ok: false,
        status: 'degraded',
        error: 'Database connection failed',
        details: err.message
      });
    }
  }

  // Fallback to disk if DATABASE_URL is not set
  const decks = readDecksFromDisk();
  res.json({
    ok: true,
    status: 'online',
    service: 'ArcaneForge MTG Deckbuilder API',
    storageMode: 'JSON File Store (Pre-Neon)',
    savedDecksCount: decks.length,
    cachedSearchQueries: searchCache.size,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Current user profile endpoint (Provides demo student profile so frontend sync works out-of-the-box)
app.get('/api/me', (_req, res) => {
  res.json({ user: DEMO_USER });
});

app.post('/api/auth/logout', (_req, res) => {
  res.status(204).end();
});

// Scryfall Proxy + Read-Through In-Memory Cache
app.get('/api/cards/search', async (req, res) => {
  const { q = 'f:commander', colors = '', type = '' } = req.query;

  let scryfallQuery = q.trim() || 'f:commander';
  if (colors) {
    scryfallQuery += ` id<=${colors.replace(/,/g, '')}`;
  }
  if (type && type !== 'all') {
    scryfallQuery += ` t:${type}`;
  }

  const cacheKey = scryfallQuery.toLowerCase();
  const cached = searchCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return res.json({
      source: 'server-cache',
      query: scryfallQuery,
      total_cards: cached.data.length,
      data: cached.data
    });
  }

  try {
    const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(scryfallQuery)}&order=edhrec`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'ArcaneForge-SchoolProject/1.0',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'No cards matched your query on Scryfall.',
        data: []
      });
    }

    const payload = await response.json();
    const cards = (payload.data || []).slice(0, 40);

    searchCache.set(cacheKey, {
      timestamp: Date.now(),
      data: cards
    });

    res.json({
      source: 'scryfall-live',
      query: scryfallQuery,
      total_cards: cards.length,
      data: cards
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reach Scryfall API', details: error.message });
  }
});

// ============================================================================
// 7. DECK CRUD ENDPOINTS (PostgreSQL with disk fallback)
// ============================================================================

// GET all decks
app.get('/api/decks', async (_req, res) => {
  try {
    if (pool) {
      const decks = await readDecksFromPostgres();
      return res.json(decks);
    }
    const decks = readDecksFromDisk();
    res.json(decks);
  } catch (error) {
    console.error('Failed to get decks:', error);
    res.status(500).json({ error: 'Failed to load decks from database' });
  }
});

// GET single deck by ID
app.get('/api/decks/:id', async (req, res) => {
  try {
    if (pool) {
      const decks = await readDecksFromPostgres();
      const deck = decks.find((d) => d.id === req.params.id);
      if (!deck) return res.status(404).json({ error: 'Deck not found' });
      return res.json(deck);
    }
    const decks = readDecksFromDisk();
    const deck = decks.find((d) => d.id === req.params.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found' });
    res.json(deck);
  } catch (error) {
    console.error('Failed to load deck:', error);
    res.status(500).json({ error: 'Failed to load deck' });
  }
});

// PUT /api/decks/:id — Update or create deck (matches React client fetch call)
app.put('/api/decks/:id', async (req, res) => {
  const deck = { ...req.body, id: req.params.id };

  if (!deck.name) {
    return res.status(400).json({ error: 'Deck name is required.' });
  }

  try {
    if (pool) {
      await saveDeckToPostgres(deck, DEMO_USER_ID);
      return res.status(204).end();
    }

    const decks = readDecksFromDisk();
    const index = decks.findIndex((d) => d.id === deck.id);
    if (index >= 0) {
      decks[index] = deck;
    } else {
      decks.push(deck);
    }
    writeDecksToDisk(decks);
    res.status(204).end();
  } catch (error) {
    console.error('Failed to save deck:', error);
    res.status(500).json({ error: 'Failed to save deck to database' });
  }
});

// POST /api/decks — Create or save deck
app.post('/api/decks', async (req, res) => {
  const { id, name, format, entries = [], commander = null, cards = [] } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Deck name is required.' });
  }

  // Handle both { entries: [...] } and legacy { cards: [...] } payloads
  let normalizedEntries = entries;
  if (normalizedEntries.length === 0 && Array.isArray(cards) && cards.length > 0) {
    normalizedEntries = cards.map((c) => ({
      card: c,
      quantity: c.quantity || 1,
      zone: c.zone || 'mainboard'
    }));
    if (commander) {
      normalizedEntries.push({ card: commander, quantity: 1, zone: 'commander' });
    }
  }

  const deckToSave = {
    id: id || `deck-${Date.now()}`,
    name,
    format: format || 'commander',
    description: req.body.description || '',
    entries: normalizedEntries
  };

  try {
    if (pool) {
      const saved = await saveDeckToPostgres(deckToSave, DEMO_USER_ID);
      return res.status(201).json(saved);
    }

    const decks = readDecksFromDisk();
    const existingIndex = decks.findIndex((d) => d.id === deckToSave.id);
    if (existingIndex >= 0) {
      decks[existingIndex] = deckToSave;
    } else {
      decks.push(deckToSave);
    }
    writeDecksToDisk(decks);
    res.status(201).json(deckToSave);
  } catch (error) {
    console.error('Failed to create deck:', error);
    res.status(500).json({ error: 'Failed to save deck' });
  }
});

// DELETE a deck
app.delete('/api/decks/:id', async (req, res) => {
  try {
    if (pool) {
      const deleted = await deleteDeckFromPostgres(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: 'Deck not found' });
      }
      return res.json({ deleted: true, id: req.params.id });
    }

    const decks = readDecksFromDisk();
    const filtered = decks.filter((d) => d.id !== req.params.id);
    writeDecksToDisk(filtered);
    res.json({ deleted: true, id: req.params.id });
  } catch (error) {
    console.error('Failed to delete deck:', error);
    res.status(500).json({ error: 'Failed to delete deck' });
  }
});

// ============================================================================
// 8. SERVER-SIDE LEGALITY & RULES VALIDATION ENGINE
// ============================================================================
app.post('/api/decks/validate', (req, res) => {
  const { format = 'commander', commander = null, cards = [] } = req.body;
  const issues = [];

  const mainboard = cards.filter((c) => c.zone === 'mainboard');
  const sideboard = cards.filter((c) => c.zone === 'sideboard');

  const mainCount = mainboard.reduce((sum, c) => sum + (c.quantity || 1), 0);
  const sideCount = sideboard.reduce((sum, c) => sum + (c.quantity || 1), 0);
  const totalCommanderCount = mainCount + (commander ? 1 : 0);

  if (format.toLowerCase() === 'commander') {
    if (!commander) {
      issues.push({ severity: 'error', message: 'Commander deck requires a designated Commander.' });
    }
    if (totalCommanderCount !== 100) {
      issues.push({
        severity: 'warning',
        message: `Commander deck has ${totalCommanderCount}/100 cards (needs exactly 100).`
      });
    }

    const cmdColors = new Set(commander?.color_identity || []);

    for (const item of mainboard) {
      const isBasic = BASIC_LANDS.has(item.name) || (item.type_line || '').includes('Basic Land');
      if (!isBasic && item.quantity > 1) {
        issues.push({
          severity: 'error',
          message: `Singleton violation: ${item.name} has ${item.quantity} copies (max 1 allowed).`
        });
      }

      if (commander) {
        const cardColors = item.color_identity || [];
        const outsideColor = cardColors.some((col) => !cmdColors.has(col));
        if (outsideColor) {
          issues.push({
            severity: 'error',
            message: `Color Identity violation: ${item.name} (${cardColors.join('')}) is outside ${commander.name}'s identity (${[...cmdColors].join('') || 'Colorless'}).`
          });
        }
      }
    }
  } else {
    // Constructed formats (Modern / Standard / Pioneer)
    if (mainCount < 60) {
      issues.push({
        severity: 'warning',
        message: `Mainboard has ${mainCount}/60 minimum cards.`
      });
    }
    if (sideCount > 15) {
      issues.push({
        severity: 'error',
        message: `Sideboard has ${sideCount}/15 maximum cards.`
      });
    }

    // Combine main + side quantities for 4-of check
    const countsByName = {};
    for (const item of [...mainboard, ...sideboard]) {
      countsByName[item.name] = (countsByName[item.name] || 0) + (item.quantity || 1);
    }

    for (const [cardName, qty] of Object.entries(countsByName)) {
      if (!BASIC_LANDS.has(cardName) && qty > 4) {
        issues.push({
          severity: 'error',
          message: `4-Copy Rule violation: ${cardName} has ${qty} total copies (max 4 allowed).`
        });
      }
    }
  }

  res.json({
    isValid: issues.filter((i) => i.severity === 'error').length === 0,
    format,
    stats: {
      mainboardCards: mainCount,
      sideboardCards: sideCount,
      totalCards: format.toLowerCase() === 'commander' ? totalCommanderCount : mainCount + sideCount
    },
    issues
  });
});

// ============================================================================
// 9. MTG ARENA TEXT PARSER ENDPOINT
// ============================================================================
app.post('/api/decks/parse', (req, res) => {
  const { text = '' } = req.body;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let currentZone = 'mainboard';
  const parsedEntries = [];

  for (const line of lines) {
    if (/^(commander|command zone):?$/i.test(line)) {
      currentZone = 'commander';
      continue;
    }
    if (/^(sideboard):?$/i.test(line)) {
      currentZone = 'sideboard';
      continue;
    }
    if (/^(deck|mainboard):?$/i.test(line)) {
      currentZone = 'mainboard';
      continue;
    }

    const match = line.match(/^(\d+)x?\s+([^(\n\r]+?)(?:\s+\([A-Z0-9]+\)\s*\d*)?$/i);
    if (match) {
      parsedEntries.push({
        quantity: parseInt(match[1], 10),
        name: match[2].trim(),
        zone: currentZone
      });
    }
  }

  res.json({
    count: parsedEntries.length,
    entries: parsedEntries
  });
});

// ============================================================================
// 10. SERVER STARTUP & DATABASE INITIALIZATION
// ============================================================================
app.listen(PORT, async () => {
  console.log(`\n============================================================`);
  console.log(`🔥 ArcaneForge Backend API running on http://localhost:${PORT}`);
  console.log(`🔍 Health check: http://localhost:${PORT}/api/health`);
  console.log(`============================================================`);

  if (pool) {
    console.log('⚡ Connecting to Neon PostgreSQL...');
    try {
      await initDatabase();
    } catch (err) {
      console.error('❌ Failed to initialize Neon PostgreSQL on startup:', err.message);
    }
  } else {
    console.log('ℹ️  No DATABASE_URL configured in .env. Using temporary file store.');
  }
});
