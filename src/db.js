// db.js — Stockage de l'historique des prix (SQLite, fichier local).
// Aucune dépendance externe à un service payant : juste un fichier .sqlite.
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { productKey } = require("./productKey.js");

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
    product_key TEXT,
    seller TEXT,
    price REAL NOT NULL,
    url TEXT,
    img TEXT,
    scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_query ON snapshots(query);
  CREATE INDEX IF NOT EXISTS idx_snapshots_name ON snapshots(name);
  CREATE INDEX IF NOT EXISTS idx_snapshots_product_key ON snapshots(product_key);

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

  -- Historise les alertes déjà envoyées pour éviter de spammer un membre
  -- à chaque scan tant que le prix erroné détecté n'a pas changé.
  CREATE TABLE IF NOT EXISTS watchlist_alerts_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    price REAL NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, query, price)
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

  -- ── Communauté : deals soumis par les membres + votes de pertinence ──
  CREATE TABLE IF NOT EXISTS community_deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    url TEXT,
    price REAL,
    image_url TEXT,
    category TEXT DEFAULT 'tout',
    seller TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_community_deals_created ON community_deals(created_at);

  CREATE TABLE IF NOT EXISTS community_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER NOT NULL REFERENCES community_deals(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    value INTEGER NOT NULL, -- 1 = pertinent, -1 = pas pertinent
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(deal_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_community_votes_deal ON community_votes(deal_id);

  -- ── Forum : catégories, sujets, réponses ──
  CREATE TABLE IF NOT EXISTS forum_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS forum_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES forum_categories(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_forum_threads_category ON forum_threads(category_id);

  CREATE TABLE IF NOT EXISTS forum_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_forum_replies_thread ON forum_replies(thread_id);
`);

// Catégories de forum par défaut — insérées une seule fois (slug UNIQUE).
const defaultForumCategories = [
  { slug: "bons-plans", name: "Bons plans", description: "Partagez et discutez des meilleures affaires du moment.", sort_order: 1 },
  { slug: "aide-astuces", name: "Aide & astuces", description: "Questions, conseils, arnaques à éviter.", sort_order: 2 },
  { slug: "general", name: "Discussions générales", description: "Tout le reste : présentations, retours, suggestions.", sort_order: 3 },
];
{
  const insertCat = db.prepare(
    "INSERT OR IGNORE INTO forum_categories (slug, name, description, sort_order) VALUES (@slug, @name, @description, @sort_order)"
  );
  for (const cat of defaultForumCategories) insertCat.run(cat);
}

// Migration sûre : si la base existe déjà depuis avant l'ajout des rôles,
// on ajoute la colonne sans tout recréer. SQLite n'a pas de
// "ADD COLUMN IF NOT EXISTS" : on tente et on ignore l'erreur si elle existe déjà.
for (const stmt of [
  "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'",
  "ALTER TABLE users ADD COLUMN pseudo TEXT",
  "ALTER TABLE users ADD COLUMN avatar_url TEXT",
  "ALTER TABLE snapshots ADD COLUMN product_key TEXT",
  "ALTER TABLE community_deals ADD COLUMN seller TEXT",
]) {
  try {
    db.exec(stmt);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

// Backfill : les lignes enregistrées avant l'ajout de product_key n'ont pas
// encore cette colonne calculée. Peu coûteux à l'échelle de cette base
// (fichier SQLite local), donc fait en JS plutôt qu'en migration SQL dédiée.
{
  const missing = db.prepare("SELECT DISTINCT name FROM snapshots WHERE product_key IS NULL").all();
  if (missing.length > 0) {
    const update = db.prepare("UPDATE snapshots SET product_key = ? WHERE name = ? AND product_key IS NULL");
    const backfill = db.transaction((names) => {
      for (const { name } of names) update.run(productKey(name), name);
    });
    backfill(missing);
  }
}

/** Enregistre une liste d'offres observées lors d'un scan. */
function insertSnapshots(query, category, offers) {
  const stmt = db.prepare(`
    INSERT INTO snapshots (query, category, name, product_key, seller, price, url, img)
    VALUES (@query, @category, @name, @product_key, @seller, @price, @url, @img)
  `);
  const insertMany = db.transaction((rows) => {
    for (const row of rows) stmt.run(row);
  });
  insertMany(
    offers.map((o) => ({
      query,
      category,
      name: o.name,
      product_key: productKey(o.name),
      seller: o.seller || null,
      price: o.price,
      url: o.url || null,
      img: o.img || null,
    }))
  );
}

/**
 * Historique des prix pour un même produit, regroupé par product_key (voir
 * productKey.js) plutôt que par titre exact : "Apple AirPods Pro 2 USB-C" et
 * "AirPods Pro 2e génération USB-C" partagent le même historique dès lors
 * qu'ils désignent le même produit, malgré des formulations différentes.
 * Accepte soit un titre brut (le product_key est calculé ici), soit un
 * product_key déjà calculé — idempotent dans les deux cas.
 */
function priceHistoryFor(nameOrKey, excludeLastMinutes = 0) {
  const key = productKey(nameOrKey);
  const rows = db
    .prepare(
      `SELECT price FROM snapshots
       WHERE product_key = ?
       ${excludeLastMinutes ? "AND scraped_at < datetime('now', ?)" : ""}
       ORDER BY scraped_at DESC LIMIT 200`
    )
    .all(...(excludeLastMinutes ? [key, `-${excludeLastMinutes} minutes`] : [key]));
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

/** Comme findUserByEmail mais par id — inclut le hash, réservé à un usage interne (vérif mot de passe). */
function findUserByIdWithHash(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function updatePassword(userId, newHash) {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(newHash, userId);
}

/** Supprime un compte et toutes ses données associées (favoris, commentaires, messages, deals communautaires, forum). */
function deleteAccount(userId) {
  const tx = db.transaction((id) => {
    db.prepare("DELETE FROM watchlist WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM comments WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM messages WHERE from_user_id = ? OR to_user_id = ?").run(id, id);
    db.prepare("DELETE FROM community_votes WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM community_deals WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM forum_replies WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM forum_threads WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  });
  tx(userId);
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
              COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url
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
              COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url
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
              COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author
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
         COALESCE(NULLIF(other.pseudo, ''), 'Membre #' || other.id) AS display_name,
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

/** Membres qui suivent cette requête (favoris), avec leur email — pour l'envoi d'alertes. */
function watchersFor(query) {
  return db
    .prepare(
      `SELECT u.id AS user_id, u.email
       FROM watchlist w JOIN users u ON u.id = w.user_id
       WHERE w.query = ?`
    )
    .all(query.toLowerCase().trim());
}

/**
 * Enregistre qu'une alerte a été envoyée à ce membre pour ce produit à ce
 * prix. INSERT OR IGNORE + UNIQUE(user_id, query, price) : renvoie true la
 * première fois (à notifier), false si déjà envoyée pour ce même prix (pas
 * de re-notification tant que le prix ne change pas).
 */
function recordAlertSent(userId, query, price) {
  const info = db
    .prepare("INSERT OR IGNORE INTO watchlist_alerts_sent (user_id, query, price) VALUES (?, ?, ?)")
    .run(userId, query.toLowerCase().trim(), price);
  return info.changes > 0;
}

// ── Communauté : deals soumis par les membres + votes ───────────
/** Enregistre un deal soumis par un membre de la communauté. */
function submitCommunityDeal(userId, { title, description, url, price, imageUrl, category, seller }) {
  const info = db
    .prepare(
      `INSERT INTO community_deals (user_id, title, description, url, price, image_url, category, seller)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, title, description || null, url || null, price ?? null, imageUrl || null, category || "tout", seller?.trim() || null);
  return getCommunityDeal(info.lastInsertRowid);
}

/**
 * Fiabilité d'un marchand telle que perçue par la communauté : ratio de
 * votes positifs sur tous les deals communautaires qui le mentionnent
 * (comparaison insensible à la casse/espaces). Reflète l'avis des membres
 * sur ce marchand, pas l'algorithme de détection de prix (données
 * distinctes, volontairement séparées).
 */
function merchantReliability(sellerName) {
  const name = (sellerName || "").trim().toLowerCase();
  if (!name) return null;
  const row = db
    .prepare(
      `SELECT
         COUNT(DISTINCT d.id) AS deal_count,
         COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
         COALESCE(SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END), 0) AS downvotes
       FROM community_deals d
       LEFT JOIN community_votes v ON v.deal_id = d.id
       WHERE lower(trim(d.seller)) = ?`
    )
    .get(name);
  if (!row || row.deal_count === 0) return { seller: sellerName, dealCount: 0, upvotes: 0, downvotes: 0, reliability: null };
  const totalVotes = row.upvotes + row.downvotes;
  const reliability = totalVotes > 0 ? Math.round((row.upvotes / totalVotes) * 100) : null;
  return { seller: sellerName, dealCount: row.deal_count, upvotes: row.upvotes, downvotes: row.downvotes, reliability };
}

/** Un deal communautaire avec son décompte de votes et l'auteur. */
function getCommunityDeal(id) {
  return db
    .prepare(
      `SELECT d.*, COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author,
              u.avatar_url,
              COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
              COALESCE(SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END), 0) AS downvotes
       FROM community_deals d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN community_votes v ON v.deal_id = d.id
       WHERE d.id = ?
       GROUP BY d.id`
    )
    .get(id);
}

/** Liste des deals communautaires, triés par catégorie, avec décompte de votes. */
function listCommunityDeals(category, limit = 50, offset = 0) {
  const rows = db
    .prepare(
      `SELECT d.*, COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author,
              u.avatar_url,
              COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
              COALESCE(SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END), 0) AS downvotes
       FROM community_deals d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN community_votes v ON v.deal_id = d.id
       WHERE (? = 'tout' OR d.category = ?)
       GROUP BY d.id
       ORDER BY d.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(category || "tout", category || "tout", limit, offset);
  return rows;
}

/** Vote (ou change son vote) sur un deal communautaire. value = 1 (pertinent) ou -1 (pas pertinent). */
function voteCommunityDeal(dealId, userId, value) {
  if (value !== 1 && value !== -1) throw new Error("value doit être 1 ou -1");
  db.prepare(
    `INSERT INTO community_votes (deal_id, user_id, value) VALUES (?, ?, ?)
     ON CONFLICT(deal_id, user_id) DO UPDATE SET value = excluded.value`
  ).run(dealId, userId, value);
  return getCommunityDeal(dealId);
}

/** Retire le vote d'un membre sur un deal (toggle off). */
function removeCommunityVote(dealId, userId) {
  db.prepare("DELETE FROM community_votes WHERE deal_id = ? AND user_id = ?").run(dealId, userId);
  return getCommunityDeal(dealId);
}

/** Le vote actuel (1, -1) d'un membre sur un deal, ou null s'il n'a pas voté. */
function getUserVote(dealId, userId) {
  const row = db.prepare("SELECT value FROM community_votes WHERE deal_id = ? AND user_id = ?").get(dealId, userId);
  return row ? row.value : null;
}

// ── Forum : catégories, sujets, réponses ─────────────────────────
function listForumCategories() {
  return db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM forum_threads t WHERE t.category_id = c.id) AS thread_count
       FROM forum_categories c ORDER BY c.sort_order ASC`
    )
    .all();
}

function getForumCategoryBySlug(slug) {
  return db.prepare("SELECT * FROM forum_categories WHERE slug = ?").get(slug);
}

/** Sujets d'une catégorie, avec auteur, nombre de réponses et date de dernière activité. */
function listForumThreads(categoryId, limit = 50) {
  return db
    .prepare(
      `SELECT t.id, t.title, t.created_at, t.user_id,
              COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url,
              (SELECT COUNT(*) FROM forum_replies r WHERE r.thread_id = t.id) AS reply_count,
              COALESCE(
                (SELECT MAX(r.created_at) FROM forum_replies r WHERE r.thread_id = t.id),
                t.created_at
              ) AS last_activity_at
       FROM forum_threads t JOIN users u ON u.id = t.user_id
       WHERE t.category_id = ?
       ORDER BY last_activity_at DESC
       LIMIT ?`
    )
    .all(categoryId, limit);
}

function getForumThread(threadId) {
  return db
    .prepare(
      `SELECT t.*, c.slug AS category_slug, c.name AS category_name,
              COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url
       FROM forum_threads t
       JOIN users u ON u.id = t.user_id
       JOIN forum_categories c ON c.id = t.category_id
       WHERE t.id = ?`
    )
    .get(threadId);
}

function createForumThread(categoryId, userId, title, body) {
  const info = db
    .prepare("INSERT INTO forum_threads (category_id, user_id, title, body) VALUES (?, ?, ?, ?)")
    .run(categoryId, userId, title, body);
  return getForumThread(info.lastInsertRowid);
}

function listForumReplies(threadId) {
  return db
    .prepare(
      `SELECT r.id, r.body, r.created_at, r.user_id,
              COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url
       FROM forum_replies r JOIN users u ON u.id = r.user_id
       WHERE r.thread_id = ? ORDER BY r.created_at ASC`
    )
    .all(threadId);
}

function addForumReply(threadId, userId, body) {
  db.prepare("INSERT INTO forum_replies (thread_id, user_id, body) VALUES (?, ?, ?)").run(threadId, userId, body);
  return listForumReplies(threadId);
}

module.exports = {
  db,
  insertSnapshots,
  priceHistoryFor,
  priceHistoryByDay,
  latestSnapshots,
  createUser,
  findUserByEmail,
  findUserByIdWithHash,
  updatePassword,
  deleteAccount,
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
  watchersFor,
  recordAlertSent,
  addComment,
  listComments,
  sendMessage,
  listPublicMessages,
  listConversation,
  listConversationsFor,
  submitCommunityDeal,
  getCommunityDeal,
  merchantReliability,
  listCommunityDeals,
  voteCommunityDeal,
  removeCommunityVote,
  getUserVote,
  listForumCategories,
  getForumCategoryBySlug,
  listForumThreads,
  getForumThread,
  createForumThread,
  listForumReplies,
  addForumReply,
};
