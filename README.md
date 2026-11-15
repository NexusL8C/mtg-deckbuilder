# ArcaneForge MTG Deckbuilder

ArcaneForge is a React/Vite Magic: The Gathering deckbuilder with Scryfall search, deck analytics, format validation, opening-hand simulation, MTG Arena decklist import/export, and cloud database persistence on Neon PostgreSQL.

## Storage Architecture (PostgreSQL on Neon)

The application uses a serverless cloud PostgreSQL database hosted on **[Neon](https://neon.tech/)**, connected through Node.js using the `pg` driver:

1. **`users`** — player accounts and profiles. Includes a built-in demo student profile for immediate out-of-the-box presentation and grading.
2. **`cards`** — local Scryfall card cache combining 3rd Normal Form (3NF) relational columns (`scryfall_id`, `name`, `mana_cost`, `cmc`, `type_line`, `color_identity`) with `JSONB` for artwork, prices, and format legalities. Stored once regardless of how many decks include the card.
3. **`decks`** — deck metadata (`id`, `user_id`, `name`, `format`, `description`, `commander_card_id`, timestamps).
4. **`deck_cards`** — many-to-many relational join table (`deck_id`, `card_id`, `quantity`, `zone`) with `ON DELETE CASCADE`.
5. **Offline Fallback** — if `DATABASE_URL` is not yet configured, the backend automatically falls back to local file storage and the browser uses `localStorage`.

### Why Neon (Cloud PostgreSQL) Instead of Local Postgres?

- **Zero Local Configuration:** No Windows service installation, no forgotten passwords, and no port 5432 conflicts.
- **Single Connection String (`DATABASE_URL`):** Works instantly across all teammate laptops and live deployments.
- **Automatic Table Creation:** When the backend starts, it runs `CREATE TABLE IF NOT EXISTS` for all 4 tables automatically.
- **Online Table Viewer & SQL Console:** Great for classroom presentations—save a deck in the browser and watch relational rows appear in Neon in real time.

---

## 🚀 Quick Setup (3 Steps)

### Step 1: Create Free Database on Neon (30 seconds)
1. Sign up / log in with your GitHub account at **[neon.tech](https://neon.tech/)** (free, no credit card required).
2. Click **Create Project** and name it `mtg-deckbuilder`.
3. Copy the **Connection String** (`postgresql://neondb_owner:...`) displayed on your dashboard.

### Step 2: Configure Environment
Copy `.env.example` to `.env` in the project root (or inside `backend/.env`):

```powershell
Copy-Item .env.example .env
```

Open `.env` and paste your Neon connection string:

```env
DATABASE_URL="postgresql://neondb_owner:YOUR_PASSWORD@ep-xyz-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require"
PORT=3001
```

### Step 3: Install & Start
In your terminal, run:

```powershell
npm.cmd install
npm.cmd start
```

That's it!
- The backend automatically initializes all tables in Neon on boot (`users`, `cards`, `decks`, `deck_cards`).
- Vite dev server launches at `http://localhost:5173`.
- Backend API runs at `http://localhost:3001` with `/api` proxied seamlessly.

---

## 🔍 Verification & Health Check

Visit `http://localhost:3001/api/health` in your browser. When connected to Neon, it returns:

```json
{
  "ok": true,
  "status": "online",
  "service": "ArcaneForge MTG Deckbuilder API",
  "storageMode": "PostgreSQL (Neon Serverless Cloud)",
  "tables": ["users", "cards", "decks", "deck_cards"],
  "savedDecksCount": 1,
  "cachedCardsCount": 35
}
```

---

## 🎓 Presentation Queries for Neon SQL Editor

During grading or project presentations, open Neon's online **SQL Editor** tab to showcase relational database concepts:

### Query 1: Many-to-Many Relational Join
```sql
SELECT d.name AS deck, dc.zone, dc.quantity, c.name AS card, c.mana_cost, c.cmc
FROM deck_cards dc
JOIN decks d ON d.id = dc.deck_id
JOIN cards c ON c.scryfall_id = dc.card_id
ORDER BY d.name, dc.zone, c.name;
```

### Query 2: Most Popular Cards Across All Decks
```sql
SELECT c.name, COUNT(DISTINCT dc.deck_id) AS deck_count, SUM(dc.quantity) AS total_copies
FROM deck_cards dc
JOIN cards c ON c.scryfall_id = dc.card_id
GROUP BY c.name
ORDER BY deck_count DESC;
```

### Query 3: Average Converted Mana Cost (CMC) per Deck
```sql
SELECT d.name, ROUND(AVG(c.cmc), 2) AS avg_cmc
FROM deck_cards dc
JOIN decks d ON d.id = dc.deck_id
JOIN cards c ON c.scryfall_id = dc.card_id
WHERE c.type_line NOT LIKE '%Land%'
GROUP BY d.id;
```

---

## Available Scripts

- `npm.cmd start` — runs backend API (port 3001) and Vite frontend concurrently.
- `npm.cmd run dev` — runs frontend dev server only.
- `npm.cmd run api` — runs backend API only.
- `npm.cmd run build` — builds frontend for production.
- `npm.cmd run lint` — runs Oxlint.
