import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ============================================================================
// 1. FILE-BASED STORAGE LAYER (Replaced by PostgreSQL in Phase 2)
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
// 2. IN-MEMORY SCRYFALL CACHE (Speeds up queries & prevents rate limits)
// ============================================================================
const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes

const BASIC_LANDS = new Set([
  'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes',
  'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp',
  'Snow-Covered Mountain', 'Snow-Covered Forest'
]);

// ============================================================================
// 3. CORE API ENDPOINTS
// ============================================================================

// Root welcome route
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to the ArcaneForge MTG Deckbuilder Backend API',
    endpoints: {
      health: '/api/health',
      searchCards: '/api/cards/search?q=sol+ring',
      decks: '/api/decks',
      validateDeck: 'POST /api/decks/validate',
      parseArenaText: 'POST /api/decks/parse'
    }
  });
});

// Health check & metrics endpoint
app.get('/api/health', (req, res) => {
  const decks = readDecksFromDisk();
  res.json({
    status: 'online',
    service: 'ArcaneForge MTG Deckbuilder API',
    storageMode: 'JSON File Store (Pre-PostgreSQL)',
    savedDecksCount: decks.length,
    cachedSearchQueries: searchCache.size,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Scryfall Proxy + Read-Through Cache
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

    // Store in memory cache
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
// 4. DECK CRUD ENDPOINTS
// ============================================================================

// GET all decks
app.get('/api/decks', (req, res) => {
  const decks = readDecksFromDisk();
  res.json(decks);
});

// GET single deck by ID
app.get('/api/decks/:id', (req, res) => {
  const decks = readDecksFromDisk();
  const deck = decks.find((d) => d.id === req.params.id);
  if (!deck) return res.status(404).json({ error: 'Deck not found' });
  res.json(deck);
});

// POST create or save a deck
app.post('/api/decks', (req, res) => {
  const { id, name, format, commander, cards = [] } = req.body;
  if (!name || !format) {
    return res.status(400).json({ error: 'Deck name and format are required.' });
  }

  const decks = readDecksFromDisk();
  const newDeck = {
    id: id || `deck-${Date.now()}`,
    name,
    format,
    commander: commander || null,
    cards,
    updatedAt: new Date().toISOString()
  };

  const existingIndex = decks.findIndex((d) => d.id === newDeck.id);
  if (existingIndex >= 0) {
    decks[existingIndex] = newDeck;
  } else {
    decks.push(newDeck);
  }

  writeDecksToDisk(decks);
  res.status(201).json(newDeck);
});

// DELETE a deck
app.delete('/api/decks/:id', (req, res) => {
  const decks = readDecksFromDisk();
  const filtered = decks.filter((d) => d.id !== req.params.id);
  writeDecksToDisk(filtered);
  res.json({ deleted: true, id: req.params.id });
});

// ============================================================================
// 5. SERVER-SIDE LEGALITY & RULES VALIDATION ENGINE
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
// 6. MTG ARENA TEXT PARSER ENDPOINT
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

    const match = line.match(/^(\d+)x?\s+([^\(]+?)(?:\s+\([A-Z0-9]+\)\s*\d*)?$/i);
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

app.listen(PORT, () => {
  console.log(`✅ ArcaneForge Backend API running on http://localhost:${PORT}`);
  console.log(`🔍 Health check: http://localhost:${PORT}/api/health`);
});