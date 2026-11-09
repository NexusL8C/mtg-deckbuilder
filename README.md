# ArcaneForge MTG Deckbuilder

ArcaneForge is a React/Vite Magic: The Gathering deckbuilder with Scryfall search, deck analytics, format validation, opening-hand simulation, and MTG Arena decklist import/export.

## Storage model

The application supports a Node.js + PostgreSQL persistence layer:

- `cards` stores the Scryfall card JSON for cards used in saved decks.
- `decks` stores deck metadata and format.
- `deck_cards` stores card quantities and zones (`commander`, `mainboard`, or `sideboard`).
- Browser `localStorage` remains an offline fallback if the API or database is unavailable.
- GitHub and Google OAuth sessions are stored in PostgreSQL, and deck records are scoped to the signed-in user.

Search results still come from Scryfall. Cards are cached in PostgreSQL when they are added to or imported into a deck.

## Dependencies

### Runtime dependencies

These packages are installed by `npm install`:

- **React** and **React DOM** — build and render the frontend interface.
- **Lucide React** — provide interface icons.
- **Recharts** — render deck analytics charts.
- **Express** — run the Node.js HTTP API.
- **pg** — connect the API to PostgreSQL.
- **Passport**, **passport-github2**, and **passport-google-oauth20** — handle GitHub and Google OAuth.
- **express-session** and **connect-pg-simple** — provide secure HTTP-only login sessions persisted in PostgreSQL.
- **dotenv** — load local environment configuration.

### Development dependencies

- **Vite** — frontend development server and production bundler.
- **`@vitejs/plugin-react`** — React support for Vite.
- **Oxlint** — JavaScript and React linting.
- **`@types/react`** and **`@types/react-dom`** — React type definitions used by tooling and editor support.

### External services and software

- **Node.js LTS** — runs Vite and the Node.js API.
- **PostgreSQL** — stores decks, deck entries, and cached Scryfall card data.
- **Scryfall API** — provides card search and card metadata.
- **Scryfall card CDN** — serves card artwork.
- **Modern web browser** — required for the React application and browser `localStorage` fallback.

The exact npm versions are defined in [`package.json`](./package.json), with the resolved dependency tree recorded in [`package-lock.json`](./package-lock.json).

## Local setup

Install dependencies:

```bash
npm install
```

Create a PostgreSQL database, copy `.env.example` to `.env`, and set `DATABASE_URL`:

```text
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mtg_deckbuilder
PORT=3001
```

Apply the schema:

```bash
psql "$DATABASE_URL" -f server/schema.sql
```

Run the API and frontend together:

```bash
npm start
```

Vite proxies `/api` requests to `http://localhost:3001` during development.
The `API` and `WEB` processes share one terminal with labeled output. Press `Ctrl+C` to stop both services.

## Windows setup

The following steps use PowerShell.

1. Install the current Node.js LTS release and PostgreSQL for Windows. During PostgreSQL installation, remember the password assigned to the `postgres` user (usually "postgres") and keep the default port `5432` unless you have changed it.

2. Open PowerShell in the repository folder and install the JavaScript dependencies:

```powershell
npm install
```

3. Create the application database. The PostgreSQL command-line tools must be available on your `PATH`; if `psql` is not recognized, run these commands from the PostgreSQL `bin` folder, commonly `C:\Program Files\PostgreSQL\<version>\bin`, or add that folder to your Windows `PATH`.

```powershell
psql -U postgres -h localhost -p 5432
```

At the `postgres=#` prompt, run:

```sql
CREATE DATABASE mtg_deckbuilder;
\q
```

4. Create the local environment file:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set `DATABASE_URL` in `.env` to match the PostgreSQL password:

```text
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/mtg_deckbuilder
PORT=3001
```

The API automatically loads `.env` when started with `npm run api`; do not commit this file.

If the password contains characters such as `@`, `:`, `/`, or `#`, URL-encode those characters in `DATABASE_URL`.

### OAuth provider setup

Authentication supports GitHub and Google OAuth. Configure either or both providers using the variables in `.env.example`:

- **GitHub:** create an OAuth App in GitHub Developer Settings and set the authorization callback URL to `http://localhost:3001/api/auth/github/callback`.
- **Google:** create an OAuth client in Google Cloud Console, choose Web application, and add `http://localhost:3001/api/auth/google/callback` as an authorized redirect URI.

Put each provider's client ID and secret in `.env`. The API exposes login links at `/api/auth/github` and `/api/auth/google`; it never stores provider passwords.

Generate a strong session secret in PowerShell:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

After adding OAuth variables, restart `npm start`. The frontend displays GitHub and Google login buttons, and deck API requests require an authenticated session.

5. Apply the database schema:

```powershell
psql -U postgres -h localhost -p 5432 -d mtg_deckbuilder -f .\server\schema.sql
```

6. Start the API and frontend together:

```powershell
npm start
```

Open the local URL printed by Vite, usually `http://localhost:5173`.

To confirm that the API can reach PostgreSQL, open this URL in a browser:

```text
http://localhost:3001/api/health
```

It should return:

```json
{"ok":true}
```

## Available scripts

- `npm run dev` — start the Vite development server.
- `npm run api` — start the Node/PostgreSQL API.
- `npm start` — start the API and Vite frontend together.
- `npm run build` — create a production frontend build.
- `npm run lint` — run Oxlint.
- `npm run preview` — preview the production frontend build.
