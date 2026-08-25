// db.js — Stockage de l'historique des prix (SQLite, fichier local).
// Aucune dépendance externe à un service payant : juste un fichier .sqlite.
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { productKey } = require("./productKey.js");
const { preparerBase, sauvegarderBase, listerSauvegardes } = require("./persistance.js");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "radarprix.sqlite");

// Crée le dossier au besoin, annonce où l'on écrit, et restaure une
// sauvegarde si la base a disparu ou est repartie vide. Doit tourner AVANT
// l'ouverture : voir src/persistance.js.
preparerBase(DB_PATH);

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    category TEXT DEFAULT 'tout',
    name TEXT NOT NULL,
    product_key TEXT,
    -- Déclaré ici POUR LES BASES NEUVES, et par ALTER TABLE plus bas pour
    -- celles qui existent déjà. L'index qui suit référence cette colonne :
    -- l'oublier ici faisait échouer la création du schéma entier.
    ean TEXT,
    seller TEXT,
    price REAL NOT NULL,
    url TEXT,
    img TEXT,
    scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_query ON snapshots(query);
  CREATE INDEX IF NOT EXISTS idx_snapshots_name ON snapshots(name);
  CREATE INDEX IF NOT EXISTS idx_snapshots_product_key ON snapshots(product_key);
  CREATE INDEX IF NOT EXISTS idx_snapshots_ean ON snapshots(ean);

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

  -- État d'une conversation privée, du point de vue d'UN des deux membres.
  --
  -- Supprimer une conversation ne peut pas effacer les messages : ils
  -- appartiennent aussi à l'autre personne, qui ne les a pas supprimés. On
  -- retient donc, par membre, jusqu'où la conversation est masquée pour lui :
  -- les messages plus anciens que ce repère ne lui sont plus servis, et la
  -- conversation disparaît de sa liste tant qu'aucun nouveau message
  -- n'arrive. Côté correspondant, rien ne change.
  CREATE TABLE IF NOT EXISTS conversation_state (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    other_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hidden_until_id INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, other_user_id)
  );

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


  -- ── Qualité de la détection ───────────────────────────────────

  -- Réglages de l'algorithme, modifiables sans redéployer. Les valeurs par
  -- défaut restent dans le code (voir REGLAGES_DEFAUT) : cette table ne
  -- contient que les écarts volontaires, ce qui rend un retour en arrière
  -- aussi simple que supprimer une ligne.
  CREATE TABLE IF NOT EXISTS settings (
    cle TEXT PRIMARY KEY,
    valeur TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Produits ou marchands bannis des résultats. Répond au cas concret
  -- "ça annonce un téléphone et c'est une coque" quand le filtrage

  -- Anomalies écartées à la main : un faux positif visible en ligne devait

  -- Produits ajoutés ou désactivés à la main, par-dessus catalog.js. Le
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
  // Le rejet d'une anomalie ne conservait que la clé normalisée du produit
  // ("128 15 iphone") : la liste des anomalies écartées était illisible.
  // On garde désormais le libellé d'origine, sans toucher à la clé qui
  // reste ce sur quoi la comparaison se fait.
  // Frais de port : une offre à 200 € plus 40 € de livraison n'est pas une
  // affaire face à 220 € livrés. La source renvoyait l'information depuis le
  // début, elle n'était simplement pas lue.
  "ALTER TABLE snapshots ADD COLUMN delivery REAL",
  // État de l'article, tel que la source le déclare dans un champ structuré.
  // Le filtre par mots-clés ne regardait que le titre : une annonce
  // reconditionnée intitulée « iPhone 15 128 Go Bleu » le traversait sans
  // encombre et se faisait scorer comme une bonne affaire sur du neuf.
  "ALTER TABLE snapshots ADD COLUMN item_condition TEXT",
  /* Le code-barres. On l'extrayait déjà — `extraction.js` lit le `gtin13` du
     balisage schema.org, `awin.js` lit l'`ean` du catalogue — et on le jetait
     à chaque relevé.

     C'est pourtant le seul pont EXACT entre deux marchands. Mesuré le 25 août
     2026 : sur 8 590 produits distincts en base, CINQ étaient vus chez deux
     vendeurs. Pas parce que les titres se ressemblent mal, mais parce qu'on
     n'avait aucun identifiant commun — un titre est une description, pas une
     identité. Deux enseignes qui vendent les mêmes jumelles Pentax portent le
     même code-barres, et aucun modèle n'a besoin de le deviner. */
  "ALTER TABLE snapshots ADD COLUMN ean TEXT",
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

// Le schéma est en place : on peut compter les comptes et prendre une copie
// de l'état courant, à côté de la base, dans le volume.
const persistance = sauvegarderBase(db, DB_PATH);

/** État de la persistance, pour le panneau « Santé du site ». Les sauvegardes
 *  sont relues à chaque appel : celle prise au démarrage n'est plus la seule
 *  dès le deuxième redéploiement. */
function etatPersistance() {
  const surVolume = !DB_PATH.startsWith(path.join(__dirname, ".."));
  return {
    chemin: DB_PATH,
    dbPathDefini: Boolean(process.env.DB_PATH),
    // Le chemin par défaut se résout sous le dossier de l'application. Il
    // tombe juste tant que le volume est monté exactement là — mais rien ne
    // le garantit, et c'est précisément ce qui a coûté les comptes.
    cheminExplicite: Boolean(process.env.DB_PATH) || surVolume,
    tailleOctets: fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0,
    comptesAuDemarrage: persistance.comptes,
    comptes: db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
    sauvegardes: listerSauvegardes(DB_PATH).map(({ fichier, taille, date }) => ({ fichier, taille, date })),
  };
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
/**
 * Un code-barres, ou rien.
 *
 * Le champ `sku` des marchands est un fourre-tout : on y trouve aussi bien un
 * EAN à treize chiffres qu'une référence interne (« LDLC-4T2-9B »), un
 * identifiant de variante, ou le titre du produit recopié. Enregistrer ce
 * fourre-tout reviendrait à rapprocher deux marchands sur la coïncidence de
 * leurs références maison — pire que de ne rien rapprocher du tout, parce
 * qu'on y croirait.
 *
 * On n'accepte donc que ce qui a la FORME d'un code-barres : 8, 12, 13 ou 14
 * chiffres (EAN-8, UPC-A, EAN-13, GTIN-14). Et on refuse les suites d'un seul
 * chiffre répété : ce sont des remplissages, jamais des produits.
 */
function eanValide(brut) {
  const chiffres = String(brut ?? "").replace(/[\s-]/g, "");
  if (!/^\d{8}$|^\d{12,14}$/.test(chiffres)) return null;
  if (/^(\d)\1+$/.test(chiffres)) return null;
  return chiffres;
}

function insertSnapshots(query, category, offers) {
  const stmt = db.prepare(`
    INSERT INTO snapshots (query, category, name, product_key, ean, seller, price, url, img, delivery, item_condition)
    VALUES (@query, @category, @name, @product_key, @ean, @seller, @price, @url, @img, @delivery, @item_condition)
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
      ean: eanValide(o.ean ?? o.sku),
      seller: o.seller || null,
      price: o.price,
      url: o.url || null,
      img: o.img || null,
      delivery: Number.isFinite(o.delivery) ? o.delivery : null,
      item_condition: o.itemCondition || null,
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


/**
 * Même chose pour plusieurs produits d'un coup.
 *
 * analyzeOffers appelait l'historique une fois par offre : sur la route
 * publique /api/deals, cela produisait quelques milliers de requêtes SQL
 * synchrones par visiteur, exécutées dans le thread principal. Une seule
 * requête pour tout le lot supprime ce coût.
 *
 * @returns {Map<string, Array>} product_key → lignes d'historique
 */
function priceHistoryBatch(namesOrKeys, { jours = 60 } = {}) {
  const cles = [...new Set(namesOrKeys.map((n) => productKey(n)))].filter(Boolean);
  const parCle = new Map(cles.map((c) => [c, []]));
  if (cles.length === 0) return parCle;

  const rows = db
    .prepare(
      `SELECT product_key, price, seller, scraped_at FROM snapshots
       WHERE product_key IN (${cles.map(() => "?").join(",")})
         AND scraped_at > datetime('now', ?)
       ORDER BY scraped_at DESC`
    )
    .all(...cles, `-${jours} days`);

  for (const r of rows) parCle.get(r.product_key)?.push(r);
  return parCle;
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
  const cle = dealQuery.toLowerCase().trim();
  db.prepare("INSERT INTO comments (deal_query, user_id, body) VALUES (?, ?, ?)").run(cle, userId, body);

  // Prévenir ceux qui ont déjà commenté ce produit : ce sont les seuls dont
  // on sache qu'ils s'y intéressent. Une notification par personne, pas une
  // par commentaire précédent — d'où le DISTINCT.
  try {
    const participants = db
      .prepare("SELECT DISTINCT user_id FROM comments WHERE deal_query = ? AND user_id != ?")
      .all(cle, userId);
    const { creerNotification } = require("./notifications");
    for (const { user_id } of participants) {
      creerNotification({
        userId: user_id,
        acteurId: userId,
        type: "commentaire_deal",
        titre: "Nouveau commentaire",
        corps: dealQuery,
        cibleVue: "produit",
        cibleId: cle,
      });
    }
  } catch (e) {
    console.error(`[comments] notification non créée : ${e.message}`);
  }
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


// ── Historique de prix agrégé par jour (pour un mini-graphique) ──
function priceHistoryByDay(query, days = 30) {
  return db
    .prepare(
      `SELECT date(scraped_at) AS day, AVG(price) AS avg_price, MIN(price) AS min_price
       FROM snapshots
       WHERE query = ? AND scraped_at >= datetime('now', ?)
       GROUP BY date(scraped_at) ORDER BY day ASC`
    )
    /* La requête était mise en minuscules ici alors que la colonne stocke la
       casse d'origine de la cible (« Catalogue Electro Dépôt ») : la
       comparaison ne remontait jamais rien, et le graphique d'historique
       d'une fiche produit restait vide en permanence. */
    .all(query.trim(), `-${days} days`);
}

/** Promeut un utilisateur admin s'il ne l'est pas déjà (idempotent). */
function promoteToAdmin(userId) {
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ? AND role != 'admin'").run(userId);
}

/**
 * Combien de produits sont vus chez PLUSIEURS marchands ?
 *
 * Question décisive, et jamais posée. `algorithm.js` a été écrit pour
 * comparer un prix à celui de ses pairs — les mêmes articles chez d'autres
 * vendeurs. Or `analyzeOffers` est appelé à l'intérieur de la boucle par
 * cible, et une cible est le catalogue d'UN marchand : deux vendeurs ne se
 * rencontrent jamais dans le même lot. Le seul pont possible est
 * `product_key` dans l'historique.
 *
 * Si ce chiffre est nul, la comparaison entre pairs n'a jamais eu lieu et
 * ne peut pas avoir lieu — et améliorer le rapprochement des titres serait
 * peaufiner une serrure sur une porte qui n'existe pas.
 */
function produitsMultiMarchands(limite = 20) {
  const propre =
    "product_key IS NOT NULL AND trim(product_key) != '' AND seller IS NOT NULL AND trim(seller) != ''";
  const avecEan = `${propre} AND ean IS NOT NULL AND trim(ean) != ''`;

  const total = db
    .prepare(`SELECT COUNT(DISTINCT product_key) AS n FROM snapshots WHERE ${propre}`)
    .get().n;

  const partages = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT product_key FROM snapshots WHERE ${propre}
         GROUP BY product_key
         HAVING COUNT(DISTINCT lower(trim(seller))) >= 2
       )`
    )
    .get().n;

  const exemples = db
    .prepare(
      `SELECT product_key,
              COUNT(DISTINCT lower(trim(seller))) AS marchands,
              COUNT(*) AS releves,
              GROUP_CONCAT(DISTINCT seller) AS vendeurs,
              MIN(price) AS mini, MAX(price) AS maxi
         FROM snapshots WHERE ${propre}
         GROUP BY product_key
         HAVING marchands >= 2
         ORDER BY marchands DESC, releves DESC
         LIMIT ?`
    )
    .all(limite);

  const marchands = db
    .prepare(
      `SELECT seller, COUNT(*) AS releves, COUNT(DISTINCT product_key) AS produits
         FROM snapshots WHERE ${propre}
         GROUP BY lower(trim(seller)) ORDER BY releves DESC LIMIT 20`
    )
    .all();

  /* Le pont exact. Un titre est une description ; un code-barres est une
     identité. On mesure les deux côte à côte pour savoir lequel travaille. */
  const relevesAvecEan = db.prepare(`SELECT COUNT(*) AS n FROM snapshots WHERE ${avecEan}`).get().n;
  const relevesTotal = db.prepare(`SELECT COUNT(*) AS n FROM snapshots WHERE ${propre}`).get().n;
  const eansPartages = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT ean FROM snapshots WHERE ${avecEan}
         GROUP BY ean HAVING COUNT(DISTINCT lower(trim(seller))) >= 2
       )`
    )
    .get().n;

  return {
    produitsDistincts: total,
    partagesEntreMarchands: partages,
    relevesTotal,
    relevesAvecEan,
    eansPartages,
    exemples,
    marchands,
  };
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
  const info = db
    .prepare("INSERT OR IGNORE INTO follows (follower_id, followed_id) VALUES (?, ?)")
    .run(followerId, followedId);

  // Seulement à la première fois : INSERT OR IGNORE ne change rien quand
  // l'abonnement existe déjà, et re-notifier à chaque clic serait absurde.
  if (info.changes > 0) {
    try {
      const suiveur = db.prepare("SELECT pseudo FROM users WHERE id = ?").get(followerId);
      require("./notifications").creerNotification({
        userId: followedId,
        acteurId: followerId,
        type: "nouvel_abonne",
        titre: "Nouvel abonné",
        corps: suiveur?.pseudo ? `${suiveur.pseudo} suit désormais votre profil.` : null,
        cibleVue: "profil",
        cibleId: followerId,
      });
    } catch (e) {
      console.error(`[follows] notification non créée : ${e.message}`);
    }
  }
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


/** Supprime les lignes de journal trop anciennes pour être utiles. */
function purgerJournaux() {
  const limite = `-${RETENTION_JOURS} day`;
  db.prepare("DELETE FROM source_events WHERE created_at < datetime('now', ?)").run(limite);
  db.prepare("DELETE FROM scan_runs WHERE started_at < datetime('now', ?)").run(limite);
}


// ── Réglages de l'algorithme ─────────────────────────────────────
//
// Les seuils vivaient en constantes dans algorithm.js : les changer
// demandait une modification du code et un redéploiement, donc personne ne
// les changeait. Ils sont désormais lisibles et modifiables depuis le
// tableau de bord.
//
// Les valeurs par défaut restent ici, dans le code. La table `settings` ne
// contient que les écarts volontaires : revenir au comportement d'origine
// se fait en supprimant une ligne, pas en se rappelant le chiffre initial.
const REGLAGES_DEFAUT = {
  seuilErreur: { valeur: 60, min: 20, max: 95, libelle: "Écart minimum pour un verdict « erreur de prix » (%)" },
  seuilDeal: { valeur: 40, min: 10, max: 90, libelle: "Écart minimum pour un verdict « bon deal » (%)" },
  minHistorique: { valeur: 3, min: 2, max: 20, libelle: "Nombre de prix passés requis pour se fier à l'historique" },
  minPairs: { valeur: 2, min: 2, max: 10, libelle: "Nombre d'offres comparables requis dans un scan" },
  remiseMinPromo: { valeur: 15, min: 0, max: 90, libelle: "Remise minimum pour publier une promotion annoncée par un marchand (%)" },
  confianceMin: { valeur: 0, min: 0, max: 100, libelle: "Confiance minimale pour publier une anomalie (0 = tout publier)" },
};

// Cache mémoire : analyzeOffers lit ces réglages pour chaque offre de chaque
// scan. Sans cache, ce serait une requête SQL par offre.
let cacheReglages = null;

function reglages() {
  if (cacheReglages) return cacheReglages;
  const lignes = db.prepare("SELECT cle, valeur FROM settings").all();
  const surcharges = Object.fromEntries(lignes.map((l) => [l.cle, Number(l.valeur)]));
  cacheReglages = Object.fromEntries(
    Object.entries(REGLAGES_DEFAUT).map(([cle, d]) => [
      cle,
      Number.isFinite(surcharges[cle]) ? surcharges[cle] : d.valeur,
    ])
  );
  return cacheReglages;
}


// ── Administration des membres ───────────────────────────────────

/**
 * Liste des membres avec recherche, filtre et tri. L'ancienne version
 * renvoyait 200 lignes brutes triées par date, sans même un champ de
 * recherche : retrouver quelqu'un demandait de parcourir la page à l'œil.
 *
 * Chaque ligne est accompagnée de ses compteurs et de son état, pour que la
 * décision de modération se prenne depuis la liste, sans ouvrir dix fiches.
 */
function listUsersAdmin({ recherche = "", filtre = "tous", tri = "recent", limit = 100, offset = 0 } = {}) {
  const q = `%${String(recherche || "").trim().toLowerCase()}%`;
  // Ces expressions s'appliquent au résultat de la sous-requête, où l'alias
  // `u` n'existe plus : elles portent sur les colonnes déjà projetées.
  const tris = {
    // Départage par identifiant : les dates SQLite s'arrêtent à la seconde,
    // et plusieurs inscriptions dans la même seconde se classeraient sinon
    // au hasard, l'ordre changeant d'un affichage à l'autre.
    recent: "created_at DESC, id DESC",
    ancien: "created_at ASC, id ASC",
    actif: "activite DESC, id DESC",
    signale: "signalements DESC, activite DESC, id DESC",
    alpha: "COALESCE(NULLIF(pseudo, ''), email) COLLATE NOCASE ASC",
  };
  const ordre = tris[tri] || tris.recent;

  // Comme les tris, ces conditions portent sur la sous-requête : pas d'alias `u`.
  const conditions = {
    tous: "1 = 1",
    suspendus: "suspended_until IS NOT NULL AND suspended_until > datetime('now')",
    equipe: "role IN ('admin', 'moderator')",
    signales: "signalements > 0",
    inactifs: "activite = 0",
  };
  const ou = conditions[filtre] || conditions.tous;

  return db
    .prepare(
      `SELECT * FROM (
         SELECT u.id, u.email, u.pseudo, u.role, u.created_at, u.avatar_url,
                u.suspended_until, u.suspension_reason,
                (SELECT COUNT(*) FROM community_deals d WHERE d.user_id = u.id) AS deals,
                (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id) AS commentaires,
                (SELECT COUNT(*) FROM messages m WHERE m.from_user_id = u.id) AS messages,
                (SELECT COUNT(*) FROM forum_threads t WHERE t.user_id = u.id)
                  + (SELECT COUNT(*) FROM forum_replies r WHERE r.user_id = u.id) AS forum,
                (SELECT COUNT(*) FROM community_deals d WHERE d.user_id = u.id)
                  + (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id)
                  + (SELECT COUNT(*) FROM messages m WHERE m.from_user_id = u.id)
                  + (SELECT COUNT(*) FROM forum_threads t WHERE t.user_id = u.id)
                  + (SELECT COUNT(*) FROM forum_replies r WHERE r.user_id = u.id) AS activite,
                -- Signalements visant les contenus de ce membre, toutes
                -- natures confondues : c'est le chiffre qui déclenche une
                -- vérification, bien plus que le volume publié.
                (SELECT COUNT(*) FROM reports rp
                   WHERE rp.status = 'ouvert' AND (
                     (rp.content_type = 'deal' AND rp.content_id IN (SELECT id FROM community_deals WHERE user_id = u.id))
                     OR (rp.content_type = 'comment' AND rp.content_id IN (SELECT id FROM comments WHERE user_id = u.id))
                     OR (rp.content_type = 'message' AND rp.content_id IN (SELECT id FROM messages WHERE from_user_id = u.id))
                     OR (rp.content_type = 'thread' AND rp.content_id IN (SELECT id FROM forum_threads WHERE user_id = u.id))
                     OR (rp.content_type = 'reply' AND rp.content_id IN (SELECT id FROM forum_replies WHERE user_id = u.id))
                   )) AS signalements
         FROM users u
         WHERE (? = '%%' OR lower(u.email) LIKE ? OR lower(COALESCE(u.pseudo, '')) LIKE ?)
       )
       WHERE ${ou}
       ORDER BY ${ordre}
       LIMIT ? OFFSET ?`
    )
    .all(q, q, q, limit, offset);
}

/** Fiche complète d'un membre, côté administration. */
function userAdminSheet(userId) {
  const u = db.prepare("SELECT id, email, pseudo, role, avatar_url, created_at, suspended_until, suspension_reason FROM users WHERE id = ?").get(userId);
  if (!u) return null;
  return {
    membre: u,
    suspension: suspensionEnCours(userId),
    stats: userStats(userId),
    activite: userActivity(userId, 30),
    // Ce qui a été fait à ce membre, et ce qu'il a signalé lui-même.
    sanctions: db
      .prepare(
        `SELECT l.*, COALESCE(NULLIF(a.pseudo, ''), a.email) AS admin_nom
         FROM moderation_log l LEFT JOIN users a ON a.id = l.admin_id
         WHERE l.target_user_id = ? ORDER BY l.id DESC LIMIT 30`
      )
      .all(userId),
    signalementsDeposes: db
      .prepare("SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ?").get(userId).n,
  };
}

/**
 * Séries quotidiennes sur N jours : inscriptions et contenus publiés.
 *
 * Les jours sans rien doivent apparaître à zéro, sinon la courbe se
 * resserre sur les seuls jours actifs et donne une fausse impression de
 * régularité. SQLite n'a pas de générateur de dates : on construit la
 * grille en JavaScript et on y verse les comptages.
 */
function seriesQuotidiennes(jours = 30) {
  const grille = [];
  const index = new Map();
  for (let i = jours - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const ligne = { jour: d, inscriptions: 0, deals: 0, commentaires: 0, messages: 0, forum: 0 };
    grille.push(ligne);
    index.set(d, ligne);
  }

  // Le forum vit dans deux tables (sujets et réponses) : on les additionne
  // pour n'avoir qu'une seule courbe « participation au forum ».
  const SOURCES = {
    inscriptions: ["users"],
    deals: ["community_deals"],
    commentaires: ["comments"],
    messages: ["messages"],
    forum: ["forum_threads", "forum_replies"],
  };

  for (const [champ, tables] of Object.entries(SOURCES)) {
    for (const table of tables) {
      const lignes = db
        .prepare(
          `SELECT date(created_at) AS jour, COUNT(*) AS n FROM ${table}
           WHERE created_at > datetime('now', '-' || ? || ' day') GROUP BY jour`
        )
        .all(jours);
      for (const r of lignes) {
        const ligne = index.get(r.jour);
        if (ligne) ligne[champ] += r.n;
      }
    }
  }
  return grille;
}

/** Membres ayant publié quelque chose sur les N derniers jours. */
function membresActifs(jours = 30) {
  return db
    .prepare(
      `SELECT COUNT(DISTINCT auteur) AS n FROM (
         SELECT user_id AS auteur, created_at FROM community_deals
         UNION ALL SELECT user_id, created_at FROM comments
         UNION ALL SELECT from_user_id, created_at FROM messages
         UNION ALL SELECT user_id, created_at FROM forum_threads
         UNION ALL SELECT user_id, created_at FROM forum_replies
       ) WHERE created_at > datetime('now', '-' || ? || ' day')`
    )
    .get(jours).n;
}

/** Lignes brutes pour un export CSV — aucune mise en forme ici. */
function exportMembres() {
  return db
    .prepare(
      `SELECT u.id, u.email, u.pseudo, u.role, u.created_at, u.suspended_until,
              (SELECT COUNT(*) FROM community_deals d WHERE d.user_id = u.id) AS deals,
              (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id) AS commentaires,
              (SELECT COUNT(*) FROM follows f WHERE f.followed_id = u.id) AS abonnes
       FROM users u ORDER BY u.id`
    )
    .all();
}

function exportDeals() {
  return db
    .prepare(
      `SELECT d.id, d.title, d.price, d.seller, d.category, d.url, d.created_at, d.expires_at,
              COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS auteur,
              COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END), 0) AS votes_pour,
              COALESCE(SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END), 0) AS votes_contre
       FROM community_deals d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN community_votes v ON v.deal_id = d.id
       GROUP BY d.id ORDER BY d.id`
    )
    .all();
}


/**
 * Consolide le journal WAL dans le fichier principal puis ferme la base.
 * Appelée à l'arrêt du serveur (voir le gestionnaire SIGTERM de server.js).
 *
 * Le checkpoint TRUNCATE est ce qui distingue un arrêt propre d'une simple
 * fermeture : sans lui, les dernières écritures restent dans le fichier
 * annexe `-wal`, que rien ne garantit de retrouver côté sauvegarde.
 */
function fermerBase() {
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
}

module.exports = {
  eanValide,
  produitsMultiMarchands,
  db,
  fermerBase,
  listUsersAdmin,
  userAdminSheet,
  seriesQuotidiennes,
  membresActifs,
  exportMembres,
  exportDeals,
  REGLAGES_DEFAUT,
  etatPersistance,
  reglages,
  debuterScan,
  terminerScan,
  listScanRuns,
  logSourceEvent,
  sourceHealth,
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
  priceHistoryBatch,
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
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
  addComment,
  listComments,
  submitCommunityDeal,
  getCommunityDeal,
  merchantReliability,
  listCommunityDeals,
  voteCommunityDeal,
  removeCommunityVote,
  getUserVote,
};
