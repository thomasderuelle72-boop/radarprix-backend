// db.js — Stockage de l'historique des prix (SQLite, fichier local).
// Aucune dépendance externe à un service payant : juste un fichier .sqlite.
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "radarprix.sqlite");
// Le dossier data/ n'existe pas toujours après un déploiement (Git ne suit pas
// les dossiers vides) : on le crée nous-mêmes pour éviter un crash au démarrage.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    category TEXT DEFAULT 'tout',
    name TEXT NOT NULL,
    seller TEXT,
    price REAL NOT NULL,
    url TEXT,
    img TEXT,
    scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_query ON snapshots(query);
  CREATE INDEX IF NOT EXISTS idx_snapshots_name ON snapshots(name);

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    category TEXT DEFAULT 'tout',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, query)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_query TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_comments_deal ON comments(deal_query);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL = salon général public
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_public ON messages(to_user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_dm ON messages(from_user_id, to_user_id);
`);

// Migration sûre : si la base existe déjà depuis avant l'ajout des rôles,
// on ajoute la colonne sans tout recréer. SQLite n'a pas de
// "ADD COLUMN IF NOT EXISTS" : on tente et on ignore l'erreur si elle existe déjà.
for (const stmt of [
  "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'",
  "ALTER TABLE users ADD COLUMN pseudo TEXT",
  "ALTER TABLE users ADD COLUMN avatar_url TEXT",
]) {
  try {
    db.exec(stmt);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

/** Enregistre une liste d'offres observées lors d'un scan. */
function insertSnapshots(query, category, offers) {
  const stmt = db.prepare(`
    INSERT INTO snapshots (query, category, name, seller, price, url, img)
    VALUES (@query, @category, @name, @seller, @price, @url, @img)
  `);
  const insertMany = db.transaction((rows) => {
    for (const row of rows) stmt.run(row);
  });
  insertMany(
    offers.map((o) => ({
      query,
      category,
      name: o.name,
      seller: o.seller || null,
      price: o.price,
      url: o.url || null,
      img: o.img || null,
    }))
  );
}

/**
 * Historique des prix pour un même produit (regroupé par nom normalisé),
 * utilisé pour calculer une moyenne de référence.
 */
function priceHistoryFor(name, excludeLastMinutes = 0) {
  const rows = db
    .prepare(
      `SELECT price FROM snapshots
       WHERE name = ?
       ${excludeLastMinutes ? "AND scraped_at < datetime('now', ?)" : ""}
       ORDER BY scraped_at DESC LIMIT 200`
    )
    .all(...(excludeLastMinutes ? [name, `-${excludeLastMinutes} minutes`] : [name]));
  return rows.map((r) => r.price);
}

/** Dernier scan (les offres les plus récentes) pour une requête donnée. */
function latestSnapshots(query, limit = 30) {
  return db
    .prepare(
      `SELECT * FROM snapshots
       WHERE query = ?
       AND scraped_at = (SELECT MAX(scraped_at) FROM snapshots WHERE query = ?)
       LIMIT ?`
    )
    .all(query, query, limit);
}

// ── Comptes utilisateurs ──────────────────────────────────────
function createUser(email, passwordHash) {
  const info = db
    .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
    .run(email.toLowerCase().trim(), passwordHash);
  return { id: info.lastInsertRowid, email: email.toLowerCase().trim() };
}

function findUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase().trim());
}

function findUserById(id) {
  return db.prepare("SELECT id, email, role, pseudo, avatar_url, created_at FROM users WHERE id = ?").get(id);
}

/** Met à jour le pseudo et/ou l'avatar d'un utilisateur (champs optionnels). */
function updateProfile(userId, { pseudo, avatarUrl }) {
  if (pseudo !== undefined) {
    db.prepare("UPDATE users SET pseudo = ? WHERE id = ?").run(pseudo, userId);
  }
  if (avatarUrl !== undefined) {
    db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(avatarUrl, userId);
  }
  return findUserById(userId);
}

/** Liste de tous les utilisateurs, pour le tableau de bord admin. */
function listUsers(limit = 100) {
  return db
    .prepare("SELECT id, email, pseudo, role, created_at FROM users ORDER BY created_at DESC LIMIT ?")
    .all(limit);
}

/** Liste "publique" des membres (sans email), pour démarrer une conversation privée. */
function listMembersPublic(excludeUserId) {
  return db
    .prepare(
      `SELECT id, COALESCE(NULLIF(pseudo, ''), 'Membre #' || id) AS display_name, avatar_url
       FROM users WHERE id != ? ORDER BY created_at DESC LIMIT 200`
    )
    .all(excludeUserId);
}

// ── Commentaires (sous un deal) ─────────────────────────────────
function addComment(dealQuery, userId, body) {
  db.prepare("INSERT INTO comments (deal_query, user_id, body) VALUES (?, ?, ?)").run(
    dealQuery.toLowerCase().trim(),
    userId,
    body
  );
}

function listComments(dealQuery, limit = 100) {
  return db
    .prepare(
      `SELECT c.id, c.body, c.created_at, u.id AS user_id,
              COALESCE(NULLIF(u.pseudo, ''), u.email) AS author, u.avatar_url
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.deal_query = ? ORDER BY c.created_at ASC LIMIT ?`
    )
    .all(dealQuery.toLowerCase().trim(), limit);
}

// ── Messages : salon général public (to_user_id NULL) + messages privés ──
function sendMessage(fromUserId, toUserId, body) {
  const info = db
    .prepare("INSERT INTO messages (from_user_id, to_user_id, body) VALUES (?, ?, ?)")
    .run(fromUserId, toUserId || null, body);
  return info.lastInsertRowid;
}

function listPublicMessages(afterId = 0, limit = 100) {
  return db
    .prepare(
      `SELECT m.id, m.body, m.created_at, u.id AS user_id,
              COALESCE(NULLIF(u.pseudo, ''), u.email) AS author, u.avatar_url
       FROM messages m JOIN users u ON u.id = m.from_user_id
       WHERE m.to_user_id IS NULL AND m.id > ?
       ORDER BY m.id ASC LIMIT ?`
    )
    .all(afterId, limit);
}

function listConversation(userId, otherUserId, limit = 200) {
  return db
    .prepare(
      `SELECT m.id, m.body, m.created_at, m.from_user_id,
              COALESCE(NULLIF(u.pseudo, ''), u.email) AS author
       FROM messages m JOIN users u ON u.id = m.from_user_id
       WHERE (m.from_user_id = ? AND m.to_user_id = ?)
          OR (m.from_user_id = ? AND m.to_user_id = ?)
       ORDER BY m.id ASC LIMIT ?`
    )
    .all(userId, otherUserId, otherUserId, userId, limit);
}

/** Liste des conversations privées d'un utilisateur, avec le dernier message de chacune. */
function listConversationsFor(userId) {
  return db
    .prepare(
      `SELECT
         other.id AS user_id,
         COALESCE(NULLIF(other.pseudo, ''), other.email) AS display_name,
         other.avatar_url,
         last_msg.body AS last_body,
         last_msg.created_at AS last_at
       FROM (
         SELECT DISTINCT CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END AS other_id
         FROM messages
         WHERE to_user_id IS NOT NULL AND (from_user_id = ? OR to_user_id = ?)
       ) AS convo
       JOIN users other ON other.id = convo.other_id
       JOIN messages last_msg ON last_msg.id = (
         SELECT id FROM messages
         WHERE (from_user_id = ? AND to_user_id = other.id) OR (from_user_id = other.id AND to_user_id = ?)
         ORDER BY id DESC LIMIT 1
       )
       ORDER BY last_msg.created_at DESC`
    )
    .all(userId, userId, userId, userId, userId);
}

// ── Historique de prix agrégé par jour (pour un mini-graphique) ──
function priceHistoryByDay(query, days = 30) {
  return db
    .prepare(
      `SELECT date(scraped_at) AS day, AVG(price) AS avg_price, MIN(price) AS min_price
       FROM snapshots
       WHERE query = ? AND scraped_at >= datetime('now', ?)
       GROUP BY date(scraped_at) ORDER BY day ASC`
    )
    .all(query.toLowerCase().trim(), `-${days} days`);
}

/** Promeut un utilisateur admin s'il ne l'est pas déjà (idempotent). */
function promoteToAdmin(userId) {
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ? AND role != 'admin'").run(userId);
}

function countUsers() {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
}

function countScans() {
  return db.prepare("SELECT COUNT(DISTINCT query || '|' || scraped_at) AS n FROM snapshots").get().n;
}

function topScannedProducts(limit = 10) {
  return db
    .prepare(
      `SELECT query, COUNT(*) AS times_seen, MAX(scraped_at) AS last_seen
       FROM snapshots GROUP BY query ORDER BY times_seen DESC LIMIT ?`
    )
    .all(limit);
}

/**
 * Liste, pour chaque produit déjà scanné (par le cron ou un scan précédent),
 * le dernier lot d'offres observé. Un "produit" = une valeur de `query`.
 * Optionnellement filtré par catégorie.
 */
function latestBatchPerProduct(category) {
  const queries = db
    .prepare(
      category && category !== "tout"
        ? "SELECT DISTINCT query FROM snapshots WHERE category = ?"
        : "SELECT DISTINCT query FROM snapshots"
    )
    .all(...(category && category !== "tout" ? [category] : []))
    .map((r) => r.query);

  return queries.map((q) => ({
    query: q,
    offers: latestSnapshots(q, 50),
  }));
}

// ── Favoris / recherches suivies ──────────────────────────────
function addToWatchlist(userId, query, category) {
  db.prepare(
    "INSERT OR IGNORE INTO watchlist (user_id, query, category) VALUES (?, ?, ?)"
  ).run(userId, query.toLowerCase().trim(), category || "tout");
}

function removeFromWatchlist(userId, query) {
  db.prepare("DELETE FROM watchlist WHERE user_id = ? AND query = ?").run(
    userId,
    query.toLowerCase().trim()
  );
}

function getWatchlist(userId) {
  return db
    .prepare("SELECT query, category, created_at FROM watchlist WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId);
}

module.exports = {
  db,
  insertSnapshots,
  priceHistoryFor,
  priceHistoryByDay,
  latestSnapshots,
  createUser,
  findUserByEmail,
  findUserById,
  updateProfile,
  listUsers,
  listMembersPublic,
  promoteToAdmin,
  countUsers,
  countScans,
  topScannedProducts,
  latestBatchPerProduct,
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
  addComment,
  listComments,
  sendMessage,
  listPublicMessages,
  listConversation,
  listConversationsFor,
};
