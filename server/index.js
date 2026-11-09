import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import passport from 'passport';
import { Strategy as GitHubStrategy } from 'passport-github2';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3001);
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL is not set; the API cannot connect to PostgreSQL.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});
const PgSession = pgSession(session);

app.use(express.json({ limit: '2mb' }));
app.set('trust proxy', 1);
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'development-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, display_name, avatar_url, provider FROM users WHERE id = $1',
      [id]
    );
    done(null, rows[0] || false);
  } catch (error) {
    done(error);
  }
});

async function findOrCreateUser(provider, profile) {
  const email = profile.emails?.[0]?.value;
  if (!email) throw new Error(`The ${provider} account did not provide an email address.`);

  const displayName = profile.displayName || profile.username || email;
  const avatarUrl = profile.photos?.[0]?.value || null;
  const providerId = String(profile.id);
  const { rows } = await pool.query(
    `INSERT INTO users (provider, provider_id, email, display_name, avatar_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, provider_id) DO UPDATE SET
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       avatar_url = EXCLUDED.avatar_url,
       updated_at = NOW()
     RETURNING id, email, display_name, avatar_url, provider`,
    [provider, providerId, email, displayName, avatarUrl]
  );
  return rows[0];
}

if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: process.env.GITHUB_CALLBACK_URL || `http://localhost:${port}/api/auth/github/callback`
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      done(null, await findOrCreateUser('github', profile));
    } catch (error) {
      done(error);
    }
  }));
}

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || `http://localhost:${port}/api/auth/google/callback`
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      done(null, await findOrCreateUser('google', profile));
    } catch (error) {
      done(error);
    }
  }));
}

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) {
    next();
    return;
  }
  res.status(401).json({ error: 'Authentication required' });
}

function normalizeDeck(deck) {
  return {
    id: String(deck.id),
    name: deck.name,
    format: deck.format,
    description: deck.description || '',
    entries: Array.isArray(deck.entries)
      ? deck.entries.map((entry) => ({
          card: entry.card,
          quantity: Number(entry.quantity),
          zone: entry.zone
        }))
      : []
  };
}

async function saveDeck(client, deck, userId) {
  const normalized = normalizeDeck(deck);

  await client.query(
    `INSERT INTO decks (id, user_id, name, format, description)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       name = EXCLUDED.name,
       format = EXCLUDED.format,
       description = EXCLUDED.description,
       updated_at = NOW()`,
    [normalized.id, userId, normalized.name, normalized.format, normalized.description]
  );

  await client.query('DELETE FROM deck_cards WHERE deck_id = $1', [normalized.id]);

  for (const entry of normalized.entries) {
    if (!entry.card?.name || !entry.zone || entry.quantity < 1) continue;

    const cardId = String(entry.card.id || entry.card.name);
    await client.query(
      `INSERT INTO cards (id, name, data)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         data = EXCLUDED.data,
         updated_at = NOW()`,
      [cardId, entry.card.name, JSON.stringify({ ...entry.card, id: cardId })]
    );

    await client.query(
      `INSERT INTO deck_cards (deck_id, card_id, zone, quantity)
       VALUES ($1, $2, $3, $4)`,
      [normalized.id, cardId, entry.zone, entry.quantity]
    );
  }
}

async function readDecks(userId) {
  const { rows } = await pool.query(
    `SELECT
       d.id,
       d.name,
       d.format,
       d.description,
       COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'card', c.data,
             'quantity', dc.quantity,
             'zone', dc.zone
           )
           ORDER BY dc.zone, c.name
         ) FILTER (WHERE dc.card_id IS NOT NULL),
         '[]'::jsonb
       ) AS entries
     FROM decks d
     LEFT JOIN deck_cards dc ON dc.deck_id = d.id
     LEFT JOIN cards c ON c.id = dc.card_id
     WHERE d.user_id = $1
     GROUP BY d.id
     ORDER BY d.created_at`,
    [userId]
  );

  return rows.map(normalizeDeck);
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (error) {
    console.error('Database health check failed:', error);
    const errorCode = error instanceof Error && 'code' in error ? error.code : 'UNKNOWN';
    res.status(503).json({
      ok: false,
      error: process.env.DATABASE_URL ? 'Database unavailable' : 'DATABASE_URL is not configured',
      code: errorCode
    });
  }
});

app.get('/api/auth/github', (req, res, next) => {
  if (!process.env.GITHUB_CLIENT_ID) {
    res.status(503).json({ error: 'GitHub OAuth is not configured' });
    return;
  }
  passport.authenticate('github', { scope: ['user:email'] })(req, res, next);
});

app.get('/api/auth/github/callback',
  passport.authenticate('github', { failureRedirect: `${frontendUrl}/?auth=failed` }),
  (_req, res) => res.redirect(frontendUrl)
);

app.get('/api/auth/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    res.status(503).json({ error: 'Google OAuth is not configured' });
    return;
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/api/auth/google/callback',
  passport.authenticate('google', { failureRedirect: `${frontendUrl}/?auth=failed` }),
  (_req, res) => res.redirect(frontendUrl)
);

app.get('/api/me', (req, res) => {
  res.json({ user: req.user || null });
});

app.post('/api/auth/logout', (req, res, next) => {
  req.logout((error) => {
    if (error) {
      next(error);
      return;
    }
    req.session.destroy((sessionError) => {
      if (sessionError) {
        next(sessionError);
        return;
      }
      res.clearCookie('connect.sid');
      res.status(204).end();
    });
  });
});

app.get('/api/decks', requireAuth, async (req, res) => {
  try {
    res.json(await readDecks(req.user.id));
  } catch (error) {
    console.error('Failed to read decks:', error);
    res.status(500).json({ error: 'Failed to read decks' });
  }
});

app.put('/api/decks/:id', requireAuth, async (req, res) => {
  const deck = { ...req.body, id: req.params.id };
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const ownership = await client.query(
      'SELECT user_id FROM decks WHERE id = $1',
      [req.params.id]
    );
    if (ownership.rowCount > 0 && ownership.rows[0].user_id !== req.user.id) {
      res.status(403).json({ error: 'You do not own this deck' });
      await client.query('ROLLBACK');
      return;
    }
    await saveDeck(client, deck, req.user.id);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Failed to save deck:', error);
    res.status(500).json({ error: 'Failed to save deck' });
  } finally {
    client.release();
  }
});

app.delete('/api/decks/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM decks WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Deck not found' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    console.error('Failed to delete deck:', error);
    res.status(500).json({ error: 'Failed to delete deck' });
  }
});

app.listen(port, () => {
  console.log(`ArcaneForge API listening on http://localhost:${port}`);
});
