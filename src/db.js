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

  -- ── Abonnements entre membres ──
  -- On suit quelqu'un pour son flair à dénicher des offres, exactement
  -- comme sur les grands sites de bons plans. Volontairement asymétrique
  -- (pas de demande à accepter) : c'est un abonnement, pas une amitié.
  CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followed_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (follower_id, followed_id)
  );
  CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_id);

  -- ── Modération ────────────────────────────────────────────────
  -- Jusqu'ici aucun contenu n'était supprimable, par personne : il fallait
  -- ouvrir le fichier SQLite à la main. moderation.js bloque le spam en
  -- amont, mais rien ne rattrapait ce qui passait au travers.

  -- Signalements déposés par les membres.
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL,   -- comment | message | deal | thread | reply
    content_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'ouvert', -- ouvert | traite | rejete
    handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    handled_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- Un membre ne signale un même contenu qu'une fois : sans ça, dix clics
    -- agacés rempliraient la file de dix lignes identiques.
    UNIQUE(reporter_id, content_type, content_id)
  );
  CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

  -- Journal des actions de modération : une suppression est irréversible,
  -- elle doit au moins laisser une trace de qui, quoi et quand.
  CREATE TABLE IF NOT EXISTS moderation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    content_type TEXT,
    content_id INTEGER,
    target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_modlog_date ON moderation_log(created_at);

  -- ── Santé du site ─────────────────────────────────────────────
  -- Les pannes (quota SerpApi épuisé, Bright Data en échec, cron muet) ne
  -- se lisaient que dans les journaux de l'hébergeur. Rien ne les remontait
  -- dans le site, alors que ce sont elles qui laissent le catalogue vide.

  -- Une ligne par exécution de scan, planifiée ou manuelle.
  CREATE TABLE IF NOT EXISTS scan_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,              -- cron | manuel
    triggered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    size INTEGER NOT NULL,
    ok_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    offers_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_scan_runs_date ON scan_runs(id);

  -- Succès et échecs des services extérieurs, pour en donner l'état sans
  -- avoir à ouvrir les journaux de l'hébergeur.
  CREATE TABLE IF NOT EXISTS source_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,              -- serpapi | brightdata | resend
    ok INTEGER NOT NULL,               -- 1 = succès, 0 = échec
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_source_events ON source_events(source, id);

  -- Emails envoyés : si une alerte ne part pas, personne ne le savait.
  CREATE TABLE IF NOT EXISTS email_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_email TEXT NOT NULL,
    subject TEXT,
    motif TEXT,                        -- erreur | seuil | admin
    ok INTEGER NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_email_log_date ON email_log(id);
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
  "ALTER TABLE watchlist ADD COLUMN target_price REAL",
  "ALTER TABLE community_deals ADD COLUMN expires_at TEXT",
  // Marque le moment où le destinataire a ouvert la conversation. Sans
  // ça, impossible de distinguer un message lu d'un message en attente :
  // la liste des conversations ne pouvait signaler aucune nouveauté.
  "ALTER TABLE messages ADD COLUMN read_at TEXT",
  // Suspension : empêcher un membre de publier sans supprimer son compte.
  // La seule action possible était jusqu'ici la suppression, qui effaçait
  // aussi tout son historique — c'était tout ou rien.
  "ALTER TABLE users ADD COLUMN suspended_until TEXT",
  "ALTER TABLE users ADD COLUMN suspension_reason TEXT",
  // Mise en avant d'un deal communautaire, sans avoir à le supprimer pour
  // le sortir de la une ni à trafiquer ses votes pour l'y faire monter.
  "ALTER TABLE community_deals ADD COLUMN pinned_at TEXT",
]) {
  try {
    db.exec(stmt);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

// Un pseudo identifie publiquement un membre (adresse de son profil, mentions
// dans le salon) : deux membres ne peuvent pas porter le même. Index partiel
// pour ne pas gêner les comptes qui n'ont pas encore choisi de pseudo.
// Si la base contient déjà des doublons, on renonce à l'index plutôt que de
// faire échouer le démarrage du serveur — l'unicité reste alors vérifiée au
// moment de l'enregistrement du profil (voir updateProfile).
try {
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pseudo_unique
     ON users(lower(trim(pseudo))) WHERE pseudo IS NOT NULL AND trim(pseudo) != ''`
  );
} catch (e) {
  console.warn("[db] index d'unicité des pseudos non créé :", e.message);
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
    db.prepare("DELETE FROM follows WHERE follower_id = ? OR followed_id = ?").run(id, id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  });
  tx(userId);
}

function findUserById(id) {
  return db.prepare("SELECT id, email, role, pseudo, avatar_url, created_at FROM users WHERE id = ?").get(id);
}

/** Ce pseudo est-il déjà porté par quelqu'un d'autre ? (comparaison insensible à la casse) */
function pseudoDejaPris(pseudo, exceptUserId) {
  const propre = String(pseudo || "").trim().toLowerCase();
  if (!propre) return false;
  const row = db
    .prepare("SELECT id FROM users WHERE lower(trim(pseudo)) = ? AND id != ?")
    .get(propre, exceptUserId || 0);
  return Boolean(row);
}

/**
 * Met à jour le pseudo et/ou l'avatar d'un utilisateur (champs optionnels).
 * @returns {{ok: true, user: object} | {ok: false, error: string}}
 */
function updateProfile(userId, { pseudo, avatarUrl }) {
  if (pseudo !== undefined && pseudoDejaPris(pseudo, userId)) {
    return { ok: false, error: "Ce pseudo est déjà utilisé par un autre membre." };
  }
  try {
    if (pseudo !== undefined) {
      db.prepare("UPDATE users SET pseudo = ? WHERE id = ?").run(pseudo, userId);
    }
    if (avatarUrl !== undefined) {
      db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(avatarUrl, userId);
    }
  } catch (e) {
    // Filet de sécurité : deux enregistrements simultanés du même pseudo
    // passent tous les deux la vérification ci-dessus, mais l'index unique
    // en arrête un.
    if (/UNIQUE constraint/i.test(e.message)) {
      return { ok: false, error: "Ce pseudo est déjà utilisé par un autre membre." };
    }
    throw e;
  }
  return { ok: true, user: findUserById(userId) };
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

/**
 * Messages du salon général.
 *
 * afterId > 0 : les messages arrivés depuis, pour le sondage régulier.
 * afterId = 0 : le premier chargement. On renvoie alors les DERNIERS
 * messages, pas les premiers — sinon, passé une centaine de messages, un
 * visiteur qui arrive découvrait l'historique le plus ancien du salon et
 * devait attendre autant de sondages qu'il y a de pages pour rattraper la
 * conversation en cours.
 */
function listPublicMessages(afterId = 0, limit = 100) {
  if (afterId > 0) {
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
  // Les N derniers, remis dans l'ordre chronologique pour l'affichage.
  return db
    .prepare(
      `SELECT * FROM (
         SELECT m.id, m.body, m.created_at, u.id AS user_id,
                COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url
         FROM messages m JOIN users u ON u.id = m.from_user_id
         WHERE m.to_user_id IS NULL
         ORDER BY m.id DESC LIMIT ?
       ) ORDER BY id ASC`
    )
    .all(limit);
}

function listConversation(userId, otherUserId, limit = 200) {
  return db
    .prepare(
      `SELECT m.id, m.body, m.created_at, m.from_user_id, m.read_at,
              COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url
       FROM messages m JOIN users u ON u.id = m.from_user_id
       WHERE (m.from_user_id = ? AND m.to_user_id = ?)
          OR (m.from_user_id = ? AND m.to_user_id = ?)
       ORDER BY m.id ASC LIMIT ?`
    )
    .all(userId, otherUserId, otherUserId, userId, limit);
}

/**
 * Marque comme lus les messages qu'un membre vient de recevoir dans une
 * conversation. Appelé à l'ouverture du fil : c'est le seul moment où l'on
 * sait de façon fiable que le destinataire les a sous les yeux.
 */
function markConversationRead(userId, otherUserId) {
  const info = db
    .prepare(
      `UPDATE messages SET read_at = datetime('now')
       WHERE to_user_id = ? AND from_user_id = ? AND read_at IS NULL`
    )
    .run(userId, otherUserId);
  return info.changes;
}

/** Total de messages privés en attente, toutes conversations confondues. */
function countUnreadMessages(userId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE to_user_id = ? AND read_at IS NULL")
    .get(userId).n;
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
         last_msg.created_at AS last_at,
         last_msg.from_user_id AS last_from,
         (SELECT COUNT(*) FROM messages nl
           WHERE nl.from_user_id = other.id AND nl.to_user_id = ? AND nl.read_at IS NULL) AS non_lus
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
       -- Sur l'identifiant du dernier message, pas sur sa date : les dates
       -- SQLite s'arrêtent à la seconde, et deux conversations actives dans
       -- la même seconde se seraient classées au hasard.
       ORDER BY last_msg.id DESC`
    )
    .all(userId, userId, userId, userId, userId, userId);
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
/**
 * Ajoute (ou met à jour) une recherche suivie. `targetPrice` est facultatif :
 * quand il est renseigné, le membre est aussi prévenu dès que le prix passe
 * sous ce seuil, et pas uniquement quand l'algorithme crie "erreur de prix".
 * ON CONFLICT plutôt qu'INSERT OR IGNORE : re-suivre un produit déjà suivi
 * doit pouvoir changer le seuil, pas être silencieusement ignoré.
 */
function addToWatchlist(userId, query, category, targetPrice) {
  const seuil = Number(targetPrice);
  db.prepare(
    `INSERT INTO watchlist (user_id, query, category, target_price) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, query) DO UPDATE SET
       category = excluded.category,
       target_price = excluded.target_price`
  ).run(
    userId,
    query.toLowerCase().trim(),
    category || "tout",
    Number.isFinite(seuil) && seuil > 0 ? seuil : null
  );
}

function removeFromWatchlist(userId, query) {
  db.prepare("DELETE FROM watchlist WHERE user_id = ? AND query = ?").run(
    userId,
    query.toLowerCase().trim()
  );
}

function getWatchlist(userId) {
  return db
    .prepare("SELECT query, category, target_price, created_at FROM watchlist WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId);
}

/** Membres qui suivent cette requête (favoris), avec leur email — pour l'envoi d'alertes. */
function watchersFor(query) {
  return db
    .prepare(
      `SELECT u.id AS user_id, u.email, w.target_price
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
function submitCommunityDeal(userId, { title, description, url, price, imageUrl, category, seller, expiresAt }) {
  const info = db
    .prepare(
      `INSERT INTO community_deals (user_id, title, description, url, price, image_url, category, seller, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId, title, description || null, url || null, price ?? null,
      imageUrl || null, category || "tout", seller?.trim() || null, expiresAt || null
    );
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
/**
 * Catégories du forum, avec de quoi montrer si l'endroit est vivant :
 * nombre de sujets, nombre total de réponses, et le dernier sujet actif
 * (titre, auteur, date). Sans ces informations, la liste des catégories
 * n'affichait qu'un compteur de sujets — impossible de savoir si quelqu'un
 * y écrit encore.
 */
function listForumCategories() {
  return db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM forum_threads t WHERE t.category_id = c.id) AS thread_count,
              (SELECT COUNT(*) FROM forum_replies r
                 JOIN forum_threads t ON t.id = r.thread_id
                WHERE t.category_id = c.id) AS reply_count,
              last.title AS last_title,
              last.id AS last_thread_id,
              last.activity_at AS last_activity_at,
              last.author AS last_author
       FROM forum_categories c
       LEFT JOIN (
         SELECT t.category_id,
                t.id,
                t.title,
                COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author,
                COALESCE((SELECT MAX(r.created_at) FROM forum_replies r WHERE r.thread_id = t.id), t.created_at) AS activity_at
           FROM forum_threads t
           JOIN users u ON u.id = t.user_id
       ) AS last
         ON last.category_id = c.id
        AND last.activity_at = (
              SELECT MAX(COALESCE((SELECT MAX(r2.created_at) FROM forum_replies r2 WHERE r2.thread_id = t2.id), t2.created_at))
                FROM forum_threads t2 WHERE t2.category_id = c.id
            )
       GROUP BY c.id
       ORDER BY c.sort_order ASC`
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

// ── Profils publics de membres ───────────────────────────────────
//
// Jusqu'ici un membre n'existait que comme un pseudo et une pastille de
// couleur en marge d'un commentaire. Rien ne permettait de savoir qui il
// était, ce qu'il avait apporté au site, ni de le suivre. C'est pourtant
// ce qui fait vivre une communauté de bons plans : on finit par suivre
// ceux qui dénichent les bonnes affaires.

/** Seuil à partir duquel un deal est considéré validé par la communauté. */
const SEUIL_DEAL_VALIDE = 3;

/**
 * Retrouve un membre par son identifiant public : un id numérique, ou un
 * pseudo. Les deux formes d'adresse restent valables — un membre qui change
 * de pseudo ne casse pas les liens déjà partagés vers son profil par id.
 */
function findUserByHandle(handle) {
  const brut = String(handle || "").trim();
  if (!brut) return null;
  if (/^\d+$/.test(brut)) {
    const parId = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(brut));
    if (parId) return parId;
  }
  return db.prepare("SELECT * FROM users WHERE lower(trim(pseudo)) = ?").get(brut.toLowerCase());
}

/** Fiche publique d'un membre : jamais l'email, jamais le rôle interne détaillé. */
function publicProfile(handle) {
  const u = findUserByHandle(handle);
  if (!u) return null;
  return {
    id: u.id,
    displayName: u.pseudo && u.pseudo.trim() ? u.pseudo.trim() : `Membre #${u.id}`,
    pseudo: u.pseudo || null,
    avatarUrl: u.avatar_url || null,
    createdAt: u.created_at,
    isAdmin: u.role === "admin",
  };
}

/** Chiffres d'activité d'un membre — uniquement des compteurs réels, rien d'estimé. */
function userStats(userId) {
  const deals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN net >= ? THEN 1 ELSE 0 END), 0) AS valides,
              COALESCE(MAX(net), 0) AS meilleur,
              COALESCE(SUM(up), 0) AS votes_recus
       FROM (
         SELECT d.id,
                COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END), 0) AS up,
                COALESCE(SUM(v.value), 0) AS net
         FROM community_deals d
         LEFT JOIN community_votes v ON v.deal_id = d.id
         WHERE d.user_id = ?
         GROUP BY d.id
       )`
    )
    .get(SEUIL_DEAL_VALIDE, userId);

  const compte = (sql, ...args) => db.prepare(sql).get(...args).n;

  const votesEmis = compte("SELECT COUNT(*) AS n FROM community_votes WHERE user_id = ?", userId);
  const categorieFavorite = db
    .prepare(
      `SELECT d.category AS categorie, COUNT(*) AS n
       FROM community_votes v JOIN community_deals d ON d.id = v.deal_id
       WHERE v.user_id = ? AND d.category IS NOT NULL AND d.category != 'tout'
       GROUP BY d.category ORDER BY n DESC LIMIT 1`
    )
    .get(userId);

  return {
    deals: {
      publies: deals.total,
      valides: deals.valides,
      partValides: deals.total > 0 ? Math.round((deals.valides / deals.total) * 100) : null,
      meilleurScore: deals.meilleur,
      votesRecus: deals.votes_recus,
    },
    commentaires: compte("SELECT COUNT(*) AS n FROM comments WHERE user_id = ?", userId),
    forum: {
      sujets: compte("SELECT COUNT(*) AS n FROM forum_threads WHERE user_id = ?", userId),
      reponses: compte("SELECT COUNT(*) AS n FROM forum_replies WHERE user_id = ?", userId),
    },
    votes: {
      emis: votesEmis,
      categorieFavorite: categorieFavorite ? categorieFavorite.categorie : null,
    },
    abonnes: compte("SELECT COUNT(*) AS n FROM follows WHERE followed_id = ?", userId),
    abonnements: compte("SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?", userId),
  };
}

/**
 * Fil d'activité : tout ce que le membre a publié, toutes sections
 * confondues, du plus récent au plus ancien.
 */
function userActivity(userId, limit = 30) {
  return db
    .prepare(
      `SELECT 'deal' AS type, d.id AS ref, d.title AS titre, NULL AS extrait, d.created_at
         FROM community_deals d WHERE d.user_id = @u
       UNION ALL
       SELECT 'comment', NULL, c.deal_query, substr(c.body, 1, 180), c.created_at
         FROM comments c WHERE c.user_id = @u
       UNION ALL
       SELECT 'thread', t.id, t.title, substr(t.body, 1, 180), t.created_at
         FROM forum_threads t WHERE t.user_id = @u
       UNION ALL
       SELECT 'reply', r.thread_id, t.title, substr(r.body, 1, 180), r.created_at
         FROM forum_replies r JOIN forum_threads t ON t.id = r.thread_id WHERE r.user_id = @u
       ORDER BY created_at DESC LIMIT @l`
    )
    .all({ u: userId, l: limit });
}

/** Les deals publiés par un membre, avec leur décompte de votes. */
function userDeals(userId, limit = 50) {
  return db
    .prepare(
      `SELECT d.*, COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url,
              COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
              COALESCE(SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END), 0) AS downvotes
       FROM community_deals d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN community_votes v ON v.deal_id = d.id
       WHERE d.user_id = ?
       GROUP BY d.id ORDER BY d.created_at DESC LIMIT ?`
    )
    .all(userId, limit);
}

/** Les sujets de forum ouverts par un membre. */
function userThreads(userId, limit = 50) {
  return db
    .prepare(
      `SELECT t.id, t.title, t.created_at, c.slug AS category_slug, c.name AS category_name,
              (SELECT COUNT(*) FROM forum_replies r WHERE r.thread_id = t.id) AS reply_count
       FROM forum_threads t JOIN forum_categories c ON c.id = t.category_id
       WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT ?`
    )
    .all(userId, limit);
}

/**
 * Dates horodatées des évènements qui font progresser chaque famille de
 * badges. Le calcul des paliers vit dans badges.js : ici on ne fait que
 * fournir la matière brute, triée du plus ancien au plus récent.
 */
function badgeEventDates(userId, plafond = 1000) {
  const dates = (sql) => db.prepare(sql).all(userId, plafond).map((r) => r.created_at);
  return {
    votes: dates("SELECT created_at FROM community_votes WHERE user_id = ? ORDER BY created_at ASC LIMIT ?"),
    deals: dates("SELECT created_at FROM community_deals WHERE user_id = ? ORDER BY created_at ASC LIMIT ?"),
    commentaires: dates("SELECT created_at FROM comments WHERE user_id = ? ORDER BY created_at ASC LIMIT ?"),
    forum: db
      .prepare(
        `SELECT created_at FROM (
           SELECT created_at FROM forum_threads WHERE user_id = @u
           UNION ALL
           SELECT created_at FROM forum_replies WHERE user_id = @u
         ) ORDER BY created_at ASC LIMIT @l`
      )
      .all({ u: userId, l: plafond })
      .map((r) => r.created_at),
    // Votes positifs reçus sur ses propres deals : c'est la reconnaissance
    // de la communauté, pas le volume publié.
    votesRecus: db
      .prepare(
        `SELECT v.created_at FROM community_votes v
         JOIN community_deals d ON d.id = v.deal_id
         WHERE d.user_id = ? AND v.value = 1
         ORDER BY v.created_at ASC LIMIT ?`
      )
      .all(userId, plafond)
      .map((r) => r.created_at),
    inscription: db.prepare("SELECT created_at FROM users WHERE id = ?").get(userId)?.created_at || null,
  };
}

// ── Abonnements ──────────────────────────────────────────────────
function followUser(followerId, followedId) {
  if (followerId === followedId) return { ok: false, error: "On ne peut pas s'abonner à soi-même." };
  db.prepare("INSERT OR IGNORE INTO follows (follower_id, followed_id) VALUES (?, ?)").run(followerId, followedId);
  return { ok: true };
}

function unfollowUser(followerId, followedId) {
  db.prepare("DELETE FROM follows WHERE follower_id = ? AND followed_id = ?").run(followerId, followedId);
  return { ok: true };
}

function isFollowing(followerId, followedId) {
  if (!followerId) return false;
  return Boolean(
    db.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?").get(followerId, followedId)
  );
}

/** Les membres suivis par quelqu'un, pour son fil personnalisé. */
function listFollowing(followerId) {
  return db
    .prepare(
      `SELECT u.id, COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS display_name, u.avatar_url
       FROM follows f JOIN users u ON u.id = f.followed_id
       WHERE f.follower_id = ? ORDER BY f.created_at DESC`
    )
    .all(followerId);
}

/** Les deals publiés par les membres qu'on suit — le fil "mes dénicheurs". */
function dealsFromFollowed(followerId, limit = 30) {
  return db
    .prepare(
      `SELECT d.*, COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url,
              COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
              COALESCE(SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END), 0) AS downvotes
       FROM follows f
       JOIN community_deals d ON d.user_id = f.followed_id
       JOIN users u ON u.id = d.user_id
       LEFT JOIN community_votes v ON v.deal_id = d.id
       WHERE f.follower_id = ?
       GROUP BY d.id ORDER BY d.created_at DESC LIMIT ?`
    )
    .all(followerId, limit);
}


// ── Modération ───────────────────────────────────────────────────
//
// Les contenus publiables sont de cinq natures, chacune dans sa table. On
// les décrit une fois ici plutôt que d'écrire cinq fois la même fonction
// de suppression et de lecture — et ça garantit qu'un nouveau type de
// contenu ne sera pas oublié par la file de signalements.
const CONTENUS = {
  comment: { table: "comments", auteur: "user_id", texte: "body", libelle: "Commentaire" },
  message: { table: "messages", auteur: "from_user_id", texte: "body", libelle: "Message" },
  deal: { table: "community_deals", auteur: "user_id", texte: "title", libelle: "Deal communautaire" },
  thread: { table: "forum_threads", auteur: "user_id", texte: "title", libelle: "Sujet du forum" },
  reply: { table: "forum_replies", auteur: "user_id", texte: "body", libelle: "Réponse du forum" },
};

const TYPES_CONTENU = Object.keys(CONTENUS);

/** Le contenu visé existe-t-il ? Renvoie son auteur et un extrait, ou null. */
function lireContenu(type, id) {
  const c = CONTENUS[type];
  if (!c || !id) return null;
  const row = db
    .prepare(`SELECT id, ${c.auteur} AS auteur_id, ${c.texte} AS extrait, created_at FROM ${c.table} WHERE id = ?`)
    .get(id);
  if (!row) return null;
  const auteur = db
    .prepare("SELECT COALESCE(NULLIF(pseudo, ''), 'Membre #' || id) AS nom FROM users WHERE id = ?")
    .get(row.auteur_id);
  return {
    type,
    libelle: c.libelle,
    id: row.id,
    auteurId: row.auteur_id,
    auteur: auteur ? auteur.nom : "compte supprimé",
    extrait: String(row.extrait || "").slice(0, 240),
    createdAt: row.created_at,
  };
}

/**
 * Supprime un contenu, quel qu'il soit, et consigne l'action.
 * @returns {{ok:true, contenu:object} | {ok:false, error:string}}
 */
function supprimerContenu(adminId, type, id, motif) {
  const c = CONTENUS[type];
  if (!c) return { ok: false, error: "Type de contenu inconnu." };
  const contenu = lireContenu(type, id);
  if (!contenu) return { ok: false, error: "Ce contenu n'existe plus." };

  const tout = db.transaction(() => {
    db.prepare(`DELETE FROM ${c.table} WHERE id = ?`).run(id);
    // Les signalements qui visaient ce contenu n'ont plus d'objet.
    db.prepare("UPDATE reports SET status = 'traite', handled_by = ?, handled_at = datetime('now') WHERE content_type = ? AND content_id = ? AND status = 'ouvert'")
      .run(adminId, type, id);
    journaliser(adminId, "suppression", {
      contentType: type,
      contentId: id,
      targetUserId: contenu.auteurId,
      detail: motif ? `${motif} — « ${contenu.extrait.slice(0, 120)} »` : `« ${contenu.extrait.slice(0, 120)} »`,
    });
  });
  tout();
  return { ok: true, contenu };
}

/** Écrit une ligne dans le journal de modération. */
function journaliser(adminId, action, { contentType, contentId, targetUserId, detail } = {}) {
  db.prepare(
    `INSERT INTO moderation_log (admin_id, action, content_type, content_id, target_user_id, detail)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(adminId || null, action, contentType || null, contentId || null, targetUserId || null, detail || null);
}

/** Journal de modération, du plus récent au plus ancien. */
function listModerationLog(limit = 100) {
  return db
    .prepare(
      `SELECT l.*,
              COALESCE(NULLIF(a.pseudo, ''), a.email) AS admin_nom,
              COALESCE(NULLIF(t.pseudo, ''), 'Membre #' || t.id) AS cible_nom
       FROM moderation_log l
       LEFT JOIN users a ON a.id = l.admin_id
       LEFT JOIN users t ON t.id = l.target_user_id
       ORDER BY l.id DESC LIMIT ?`
    )
    .all(limit);
}

// ── Signalements ─────────────────────────────────────────────────
function signalerContenu(reporterId, type, id, reason, note) {
  if (!CONTENUS[type]) return { ok: false, error: "Type de contenu inconnu." };
  const contenu = lireContenu(type, id);
  if (!contenu) return { ok: false, error: "Ce contenu n'existe plus." };
  if (contenu.auteurId === reporterId) return { ok: false, error: "Inutile de signaler son propre contenu." };
  try {
    db.prepare(
      "INSERT INTO reports (reporter_id, content_type, content_id, reason, note) VALUES (?, ?, ?, ?, ?)"
    ).run(reporterId, type, id, reason, note || null);
  } catch (e) {
    // Deuxième signalement du même contenu par la même personne : ce n'est
    // pas une erreur de son point de vue, le signalement est déjà pris en compte.
    if (/UNIQUE constraint/i.test(e.message)) return { ok: true, deja: true };
    throw e;
  }
  return { ok: true };
}

/**
 * File de signalements. Chaque ligne est enrichie du contenu visé — s'il a
 * disparu entre-temps, on le dit plutôt que d'afficher une ligne vide.
 */
function listReports(statut = "ouvert", limit = 100) {
  const rows = db
    .prepare(
      `SELECT r.*, COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS signale_par
       FROM reports r JOIN users u ON u.id = r.reporter_id
       WHERE (? = 'tous' OR r.status = ?)
       ORDER BY r.id DESC LIMIT ?`
    )
    .all(statut, statut, limit);
  return rows.map((r) => ({ ...r, contenu: lireContenu(r.content_type, r.content_id) }));
}

function countOpenReports() {
  return db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'ouvert'").get().n;
}

/** Classe un signalement sans supprimer le contenu (fausse alerte). */
function rejeterSignalement(adminId, reportId) {
  const info = db
    .prepare("UPDATE reports SET status = 'rejete', handled_by = ?, handled_at = datetime('now') WHERE id = ? AND status = 'ouvert'")
    .run(adminId, reportId);
  if (info.changes > 0) journaliser(adminId, "signalement rejeté", { contentId: reportId });
  return info.changes > 0;
}

// ── Suspension d'un membre ───────────────────────────────────────
/**
 * Suspend un membre pour un nombre de jours donné. `jours = 0` lève la
 * suspension. On ne touche pas à ses contenus : suspendre n'est pas punir
 * rétroactivement, c'est empêcher de publier.
 */
function suspendreMembre(adminId, userId, jours, motif) {
  const cible = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
  if (!cible) return { ok: false, error: "Membre introuvable." };
  if (cible.role === "admin") return { ok: false, error: "Un administrateur ne peut pas être suspendu." };

  if (!jours || jours <= 0) {
    db.prepare("UPDATE users SET suspended_until = NULL, suspension_reason = NULL WHERE id = ?").run(userId);
    journaliser(adminId, "levée de suspension", { targetUserId: userId });
    return { ok: true, jusquA: null };
  }
  const jusquA = new Date(Date.now() + jours * 86400000).toISOString().slice(0, 19).replace("T", " ");
  db.prepare("UPDATE users SET suspended_until = ?, suspension_reason = ? WHERE id = ?")
    .run(jusquA, motif || null, userId);
  journaliser(adminId, "suspension", { targetUserId: userId, detail: `${jours} jour(s)${motif ? " — " + motif : ""}` });
  return { ok: true, jusquA };
}

/** Suspension en cours d'un membre, ou null. Les suspensions expirées sont ignorées. */
function suspensionEnCours(userId) {
  const u = db.prepare("SELECT suspended_until, suspension_reason FROM users WHERE id = ?").get(userId);
  if (!u || !u.suspended_until) return null;
  const fin = new Date(u.suspended_until.replace(" ", "T") + "Z");
  if (fin <= new Date()) return null;
  return { jusquA: u.suspended_until, motif: u.suspension_reason };
}

// ── Rôles ────────────────────────────────────────────────────────
const ROLES = ["user", "moderator", "admin"];

/**
 * Change le rôle d'un membre. Réservé aux administrateurs : un modérateur
 * ne peut pas se promouvoir lui-même ni nommer quelqu'un.
 */
function definirRole(adminId, userId, role) {
  if (!ROLES.includes(role)) return { ok: false, error: "Rôle inconnu." };
  if (adminId === userId) return { ok: false, error: "On ne change pas son propre rôle." };
  const cible = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!cible) return { ok: false, error: "Membre introuvable." };
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
  journaliser(adminId, "changement de rôle", { targetUserId: userId, detail: role });
  return { ok: true };
}

// ── Épinglage d'un deal ──────────────────────────────────────────
function epinglerDeal(adminId, dealId, epingle) {
  const deal = db.prepare("SELECT id FROM community_deals WHERE id = ?").get(dealId);
  if (!deal) return { ok: false, error: "Deal introuvable." };
  db.prepare("UPDATE community_deals SET pinned_at = ? WHERE id = ?")
    .run(epingle ? new Date().toISOString().slice(0, 19).replace("T", " ") : null, dealId);
  journaliser(adminId, epingle ? "deal épinglé" : "deal désépinglé", { contentType: "deal", contentId: dealId });
  return { ok: true };
}


// ── Santé du site : scans, sources extérieures, emails ───────────
//
// Ces trois journaux ne servent qu'à répondre à une question : « pourquoi
// le site ne trouve-t-il rien en ce moment ? ». Ils sont volontairement
// bornés (purge des lignes anciennes) : ce sont des indicateurs, pas des
// archives, et la base tient dans un fichier.

const RETENTION_JOURS = 30;

/** Ouvre une exécution de scan et renvoie son identifiant. */
function debuterScan(source, size, triggeredBy) {
  const info = db
    .prepare("INSERT INTO scan_runs (source, triggered_by, size) VALUES (?, ?, ?)")
    .run(source, triggeredBy || null, size);
  return info.lastInsertRowid;
}

/** Referme une exécution avec son bilan. */
function terminerScan(runId, { okCount = 0, failCount = 0, offersCount = 0, error = null } = {}) {
  if (!runId) return;
  db.prepare(
    `UPDATE scan_runs SET ok_count = ?, fail_count = ?, offers_count = ?, error = ?,
            finished_at = datetime('now') WHERE id = ?`
  ).run(okCount, failCount, offersCount, error, runId);
  purgerJournaux();
}

function listScanRuns(limit = 30) {
  return db
    .prepare(
      `SELECT r.*, COALESCE(NULLIF(u.pseudo, ''), u.email) AS lance_par
       FROM scan_runs r LEFT JOIN users u ON u.id = r.triggered_by
       ORDER BY r.id DESC LIMIT ?`
    )
    .all(limit);
}

/** Consigne un appel à un service extérieur. */
function logSourceEvent(source, ok, detail) {
  db.prepare("INSERT INTO source_events (source, ok, detail) VALUES (?, ?, ?)")
    .run(source, ok ? 1 : 0, detail ? String(detail).slice(0, 300) : null);
}

/**
 * État de chaque service : dernier succès, dernier échec, et surtout la
 * série d'échecs en cours — c'est elle qui distingue un hoquet passager
 * d'une panne installée.
 */
function sourceHealth() {
  const sources = ["serpapi", "brightdata", "resend"];
  return sources.map((source) => {
    const dernier = (ok) =>
      db.prepare("SELECT created_at, detail FROM source_events WHERE source = ? AND ok = ? ORDER BY id DESC LIMIT 1")
        .get(source, ok);
    const recents = db
      .prepare("SELECT ok FROM source_events WHERE source = ? ORDER BY id DESC LIMIT 50")
      .all(source);
    let serieEchecs = 0;
    for (const e of recents) {
      if (e.ok === 1) break;
      serieEchecs++;
    }
    const sur24h = db
      .prepare(
        `SELECT SUM(ok) AS succes, COUNT(*) AS total FROM source_events
         WHERE source = ? AND created_at > datetime('now', '-1 day')`
      )
      .get(source);
    const succes = dernier(1);
    const echec = dernier(0);
    return {
      source,
      dernierSucces: succes?.created_at || null,
      dernierEchec: echec?.created_at || null,
      dernierMessage: echec?.detail || null,
      serieEchecs,
      // "aucune donnée" est un état à part entière : ne rien avoir tenté
      // n'est pas la même chose qu'avoir échoué.
      etat: recents.length === 0 ? "inconnu" : serieEchecs === 0 ? "ok" : serieEchecs >= 5 ? "panne" : "instable",
      appels24h: sur24h?.total || 0,
      succes24h: sur24h?.succes || 0,
    };
  });
}

/** Consigne un envoi d'email, réussi ou non. */
function logEmail({ to, subject, motif, ok, error }) {
  db.prepare("INSERT INTO email_log (to_email, subject, motif, ok, error) VALUES (?, ?, ?, ?, ?)")
    .run(to, subject || null, motif || null, ok ? 1 : 0, error ? String(error).slice(0, 300) : null);
}

function listEmailLog(limit = 50) {
  return db.prepare("SELECT * FROM email_log ORDER BY id DESC LIMIT ?").all(limit);
}

function emailStats() {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(ok) AS envoyes FROM email_log
       WHERE created_at > datetime('now', '-7 day')`
    )
    .get();
  return { total7j: r.total || 0, envoyes7j: r.envoyes || 0, echecs7j: (r.total || 0) - (r.envoyes || 0) };
}

/** Supprime les lignes de journal trop anciennes pour être utiles. */
function purgerJournaux() {
  const limite = `-${RETENTION_JOURS} day`;
  db.prepare("DELETE FROM source_events WHERE created_at < datetime('now', ?)").run(limite);
  db.prepare("DELETE FROM email_log WHERE created_at < datetime('now', ?)").run(limite);
  db.prepare("DELETE FROM scan_runs WHERE started_at < datetime('now', ?)").run(limite);
}

module.exports = {
  db,
  debuterScan,
  terminerScan,
  listScanRuns,
  logSourceEvent,
  sourceHealth,
  logEmail,
  listEmailLog,
  emailStats,
  purgerJournaux,
  TYPES_CONTENU,
  lireContenu,
  supprimerContenu,
  journaliser,
  listModerationLog,
  signalerContenu,
  listReports,
  countOpenReports,
  rejeterSignalement,
  suspendreMembre,
  suspensionEnCours,
  definirRole,
  epinglerDeal,
  SEUIL_DEAL_VALIDE,
  findUserByHandle,
  publicProfile,
  userStats,
  userActivity,
  userDeals,
  userThreads,
  badgeEventDates,
  followUser,
  unfollowUser,
  isFollowing,
  listFollowing,
  dealsFromFollowed,
  pseudoDejaPris,
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
  markConversationRead,
  countUnreadMessages,
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
