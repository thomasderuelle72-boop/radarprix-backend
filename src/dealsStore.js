// dealsStore.js — Modèle de données commun aux quatre détecteurs.
//
// Jusqu'ici, la seule chose que le backend savait représenter était une
// observation de prix (table `snapshots`). Or un bon plan n'est pas toujours
// un prix : un code promo ne change pas le prix affiché, une offre de
// remboursement non plus, un échantillon offert n'a pas de prix du tout.
// Trois des cinq natures de bons plans que publie une plateforme comme
// Dealabs étaient donc structurellement impossibles à stocker.
//
// Cette table est le point de convergence des quatre détecteurs :
//   D1  promotions et codes promo (flux d'affiliation)
//   D2  gratuit (plateformes de jeux, échantillons)
//   D3  anomalies de prix (erreur de prix, bon deal)
//   D4  occasion et reconditionné
//
// Elle vit dans son propre module plutôt que dans db.js, déjà à 2 000 lignes :
// la connexion SQLite est partagée, le schéma est local.
const { db } = require("./db");

// ── Vocabulaire contrôlé ────────────────────────────────────────────
// Écrit une fois ici plutôt que dupliqué en chaînes libres dans chaque
// détecteur : une faute de frappe dans un type rendrait des deals
// invisibles au filtrage sans qu'aucune erreur ne soit levée.
const TYPES_DEAL = ["erreur", "promo", "code", "gratuit", "odr", "occasion"];
const DETECTEURS = ["D1", "D2", "D3", "D4"];
const ETATS = ["neuf", "reconditionne", "occasion"];

db.exec(`
  CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Identité de l'offre chez sa source. C'est ce couple qui rend
    -- l'ingestion idempotente : relire le même flux dix fois ne crée pas
    -- dix lignes, il met à jour la même.
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,

    detector TEXT NOT NULL,
    type TEXT NOT NULL,

    title TEXT NOT NULL,
    description TEXT,
    url TEXT,
    image_url TEXT,
    merchant TEXT,
    category TEXT NOT NULL DEFAULT 'tout',
    item_condition TEXT NOT NULL DEFAULT 'neuf',

    -- price = ce que paie réellement l'acheteur (0 pour du gratuit).
    price REAL,
    -- reference_price = référence OBSERVÉE par RadarPrix (médiane entre
    -- marchands, ou plus bas prix relevé). Jamais le prix barré du
    -- marchand : celui-ci est un argument marketing, souvent un prix
    -- conseillé jamais pratiqué, et s'en servir reviendrait à laisser
    -- chaque marchand fixer lui-même l'ampleur de sa remise affichée.
    reference_price REAL,
    discount_pct INTEGER,
    currency TEXT NOT NULL DEFAULT 'EUR',

    -- Code à saisir au panier (type 'code'), NULL pour tout le reste.
    voucher_code TEXT,

    -- score      : désirabilité, tient lieu de température communautaire
    --              tant qu'il n'y a pas assez de votes (voir curation.js).
    -- confidence : fiabilité de la détection, renseignée par D3 seulement.
    score INTEGER NOT NULL DEFAULT 0,
    confidence INTEGER,

    starts_at TEXT,
    expires_at TEXT,

    -- NULL tant que le deal n'a pas passé le seuil de publication. C'est
    -- le garde-fou contre le déversement brut des flux d'affiliation, qui
    -- produiraient plusieurs milliers d'offres médiocres par jour.
    published_at TEXT,

    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- Renseigné quand l'offre disparaît de son flux d'origine : une offre
    -- retirée par le marchand doit cesser d'être servie, même si sa date
    -- d'expiration annoncée n'est pas encore atteinte.
    removed_at TEXT,

    -- Charge utile brute de la source, en JSON. Permet de rejouer une
    -- normalisation corrigée sans redemander le flux.
    payload TEXT,

    UNIQUE(source, external_id)
  );

  -- Jugements de la modération sur les deals publiés automatiquement.
  --
  -- La table vit ici, avec les deals qu'elle qualifie, et non dans le module
  -- de mesure qui l'alimente : reputation.js la lit sans rien savoir de la
  -- mesure, et faire dépendre son existence de l'ordre des require() est le
  -- genre de fragilité qui ne se manifeste qu'en production, le jour où un
  -- module cesse d'être chargé.
  CREATE TABLE IF NOT EXISTS deal_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    verdict TEXT NOT NULL, -- 'faux_positif' | 'valide'
    motif TEXT,
    user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(deal_id)
  );

  CREATE INDEX IF NOT EXISTS idx_deals_feed
    ON deals(published_at, score);
  CREATE INDEX IF NOT EXISTS idx_deals_type ON deals(type);
  CREATE INDEX IF NOT EXISTS idx_deals_category ON deals(category);
  CREATE INDEX IF NOT EXISTS idx_deals_condition ON deals(item_condition);
  CREATE INDEX IF NOT EXISTS idx_deals_expiry ON deals(expires_at);
`);

/**
 * Convertit une date ISO 8601 ("2026-08-21T15:00:00.000Z") au format que
 * produit datetime('now') en SQLite ("2026-08-21 15:00:00").
 *
 * Ce n'est pas cosmétique : les deux formats se comparent comme des chaînes,
 * et à date égale le 'T' de l'ISO (0x54) est toujours supérieur à l'espace
 * (0x20). Une offre expirant à 09:00 aujourd'hui serait donc jugée encore
 * valide à 14:00 — l'expiration ne fonctionnerait qu'un jour sur deux.
 * Renvoie null sur une date invalide plutôt que d'écrire une chaîne qui
 * fausserait silencieusement toutes les comparaisons.
 */
function versDateSql(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Valide et complète un deal avant écriture. Lève sur un type ou un
 * détecteur inconnu : mieux vaut faire échouer bruyamment l'ingestion d'une
 * source mal branchée que d'accumuler silencieusement des lignes que rien
 * ne viendra jamais lire.
 */
function normaliser(d) {
  if (!TYPES_DEAL.includes(d.type)) {
    throw new Error(`Type de deal inconnu : "${d.type}" (attendus : ${TYPES_DEAL.join(", ")})`);
  }
  if (!DETECTEURS.includes(d.detector)) {
    throw new Error(`Détecteur inconnu : "${d.detector}" (attendus : ${DETECTEURS.join(", ")})`);
  }
  const etat = d.itemCondition || "neuf";
  if (!ETATS.includes(etat)) {
    throw new Error(`État inconnu : "${etat}" (attendus : ${ETATS.join(", ")})`);
  }
  if (!d.source || !d.externalId) {
    throw new Error("Un deal doit porter une source et un identifiant externe (dédoublonnage).");
  }
  if (!d.title) throw new Error("Un deal doit porter un titre.");

  // Remise calculée ici plutôt que par chaque source : une seule règle,
  // et elle ne s'appuie que sur une référence observée.
  let pct = d.discountPct;
  if (pct == null && Number.isFinite(d.price) && Number.isFinite(d.referencePrice) && d.referencePrice > 0) {
    pct = Math.round((1 - d.price / d.referencePrice) * 100);
  }

  return {
    source: d.source,
    external_id: String(d.externalId),
    detector: d.detector,
    type: d.type,
    title: d.title,
    description: d.description || null,
    url: d.url || null,
    image_url: d.imageUrl || null,
    merchant: d.merchant || null,
    category: d.category || "tout",
    item_condition: etat,
    price: Number.isFinite(d.price) ? d.price : null,
    reference_price: Number.isFinite(d.referencePrice) ? d.referencePrice : null,
    discount_pct: Number.isFinite(pct) ? pct : null,
    currency: d.currency || "EUR",
    voucher_code: d.voucherCode || null,
    score: Number.isFinite(d.score) ? Math.round(d.score) : 0,
    confidence: Number.isFinite(d.confidence) ? Math.round(d.confidence) : null,
    // Les sources externes datent en ISO, SQLite en "YYYY-MM-DD HH:MM:SS".
    // La conversion est faite ici, une fois, plutôt que dans chaque source :
    // c'est la table qui impose son format.
    starts_at: versDateSql(d.startsAt),
    expires_at: versDateSql(d.expiresAt),
    published_at: d.publishedAt || null,
    payload: d.payload ? JSON.stringify(d.payload) : null,
  };
}

const upsertStmt = db.prepare(`
  INSERT INTO deals (
    source, external_id, detector, type, title, description, url, image_url,
    merchant, category, item_condition, price, reference_price, discount_pct,
    currency, voucher_code, score, confidence, starts_at, expires_at,
    published_at, payload
  ) VALUES (
    @source, @external_id, @detector, @type, @title, @description, @url, @image_url,
    @merchant, @category, @item_condition, @price, @reference_price, @discount_pct,
    @currency, @voucher_code, @score, @confidence, @starts_at, @expires_at,
    @published_at, @payload
  )
  ON CONFLICT(source, external_id) DO UPDATE SET
    title           = excluded.title,
    description     = excluded.description,
    url             = excluded.url,
    image_url       = excluded.image_url,
    merchant        = excluded.merchant,
    category        = excluded.category,
    item_condition  = excluded.item_condition,
    price           = excluded.price,
    reference_price = excluded.reference_price,
    discount_pct    = excluded.discount_pct,
    voucher_code    = excluded.voucher_code,
    score           = excluded.score,
    confidence      = excluded.confidence,
    starts_at       = excluded.starts_at,
    expires_at      = excluded.expires_at,
    payload         = excluded.payload,
    last_seen_at    = datetime('now'),
    -- Une offre revue dans son flux n'est plus considérée comme retirée :
    -- les marchands remettent régulièrement en ligne une promotion
    -- suspendue quelques heures.
    removed_at      = NULL
  WHERE deals.source = excluded.source AND deals.external_id = excluded.external_id
`);

/** Insère ou met à jour un deal. Renvoie son identifiant interne. */
function upsertDeal(deal) {
  const row = normaliser(deal);
  upsertStmt.run(row);
  return db
    .prepare("SELECT id FROM deals WHERE source = ? AND external_id = ?")
    .get(row.source, row.external_id).id;
}

/** Insère ou met à jour un lot, en une seule transaction. */
const upsertDeals = db.transaction((deals) => {
  let n = 0;
  for (const d of deals) {
    upsertDeal(d);
    n++;
  }
  return n;
});

/**
 * Marque comme retirées les offres d'une source qui n'apparaissent plus dans
 * son flux. Sans ça, un code promo supprimé par le marchand resterait affiché
 * jusqu'à sa date d'expiration annoncée — c'est-à-dire souvent jamais.
 * Ne fait rien si la liste est vide : un flux qui répond mal (panne réseau,
 * quota) ne doit pas faire disparaître tout le contenu déjà collecté.
 */
function markMissingAsRemoved(source, externalIdsVus) {
  if (!externalIdsVus || externalIdsVus.length === 0) return 0;
  const placeholders = externalIdsVus.map(() => "?").join(",");
  const res = db
    .prepare(
      `UPDATE deals SET removed_at = datetime('now')
       WHERE source = ? AND removed_at IS NULL
         AND external_id NOT IN (${placeholders})`
    )
    .run(source, ...externalIdsVus.map(String));
  return res.changes;
}

/**
 * Liste paginée du flux public. Ne sert que des deals publiés, non retirés et
 * non expirés — la lecture n'a aucun calcul à faire, contrairement à
 * l'ancienne route /api/deals qui réanalysait tout à chaque visiteur.
 */
/* Recherche insensible aux accents. SQLite ne sait pas les ignorer nativement
   et `LIKE` ne gère la casse que pour l'ASCII : sans cette fonction, chercher
   « beaute » ne trouverait pas « beauté ». Enregistrée une fois ici plutôt
   que d'imposer à chaque appelant de plier sa chaîne lui-même — c'est côté
   base que la comparaison a lieu. */
db.function("sans_accent", (texte) =>
  (texte || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
);

function listDeals({
  type = null,
  types = null,
  category = "tout",
  itemCondition = null,
  detector = null,
  q = null,
  page = 1,
  pageSize = 20,
  includeUnpublished = false,
} = {}) {
  const where = ["d.removed_at IS NULL"];
  const params = [];

  if (!includeUnpublished) where.push("d.published_at IS NOT NULL");
  // Une offre dont la date de fin est passée n'est plus une offre.
  where.push("(d.expires_at IS NULL OR d.expires_at > datetime('now'))");
  // Ni une offre qui n'a pas encore commencé : les sources annoncent leurs
  // promotions à l'avance (Epic publie le jeu gratuit de la semaine
  // suivante), et l'annoncer comme disponible enverrait le membre sur une
  // page encore payante.
  where.push("(d.starts_at IS NULL OR d.starts_at <= datetime('now'))");

  if (type) {
    where.push("d.type = ?");
    params.push(type);
  } else if (types && types.length > 0) {
    where.push(`d.type IN (${types.map(() => "?").join(",")})`);
    params.push(...types);
  }
  if (category && category !== "tout") {
    where.push("d.category = ?");
    params.push(category);
  }
  if (itemCondition) {
    where.push("d.item_condition = ?");
    params.push(itemCondition);
  } else {
    // Par défaut le flux principal ne mélange pas le neuf et le
    // reconditionné : l'occasion a sa propre section.
    where.push("d.item_condition = 'neuf'");
  }
  if (detector) {
    where.push("d.detector = ?");
    params.push(detector);
  }
  if (q && q.trim()) {
    // Filtre par mot-clé sur des offres DÉJÀ qualifiées individuellement :
    // une recherche large comme « pc » parcourt ainsi tout ce qui a été
    // détecté sur des PC, sans jamais comparer entre eux des produits
    // différents — la comparaison a eu lieu au moment du scan.
    where.push("sans_accent(d.title) LIKE '%' || sans_accent(?) || '%'");
    params.push(q.trim());
  }

  const clause = where.join(" AND ");
  const total = db.prepare(`SELECT COUNT(*) AS n FROM deals d WHERE ${clause}`).get(...params).n;

  const taille = Math.min(50, Math.max(1, pageSize));
  const numero = Math.max(1, page);
  const items = db
    .prepare(
      `SELECT d.* FROM deals d WHERE ${clause}
       ORDER BY d.score DESC, d.first_seen_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, taille, (numero - 1) * taille);

  return {
    page: numero,
    pageSize: taille,
    total,
    hasMore: numero * taille < total,
    items: items.map(enJson),
  };
}

/** Forme servie à l'API : camelCase, payload décodé, champs internes retirés. */
function enJson(row) {
  return {
    id: row.id,
    source: row.source,
    detector: row.detector,
    type: row.type,
    title: row.title,
    description: row.description,
    url: row.url,
    imageUrl: row.image_url,
    merchant: row.merchant,
    category: row.category,
    itemCondition: row.item_condition,
    price: row.price,
    referencePrice: row.reference_price,
    discountPct: row.discount_pct,
    currency: row.currency,
    voucherCode: row.voucher_code,
    score: row.score,
    confidence: row.confidence,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    publishedAt: row.published_at,
    firstSeenAt: row.first_seen_at,
    // Détails propres au détecteur : prix affiché hors port, frais de port,
    // score z, « plus bas prix jamais vu »… Ce sont des informations que
    // l'interface affiche (le badge « au plus bas », par exemple), pas des
    // données internes — les garder ici obligeait chaque appelant à relire
    // la ligne brute pour y accéder.
    payload: décoderPayload(row.payload),
  };
}

/** Le payload est stocké en JSON ; une ligne corrompue ne doit rien casser. */
function décoderPayload(brut) {
  if (!brut) return null;
  try {
    return JSON.parse(brut);
  } catch {
    return null;
  }
}

/** Publie un deal (le rend visible dans le flux public). */
function publierDeal(id) {
  db.prepare("UPDATE deals SET published_at = datetime('now') WHERE id = ? AND published_at IS NULL").run(id);
}

/** Retire un deal du flux public sans le supprimer (modération). */
function depublierDeal(id) {
  db.prepare("UPDATE deals SET published_at = NULL WHERE id = ?").run(id);
}

/** Répartition par type et par détecteur — sert au tableau de bord admin. */
function statsDeals() {
  return db
    .prepare(
      `SELECT detector, type,
              COUNT(*) AS total,
              SUM(CASE WHEN published_at IS NOT NULL THEN 1 ELSE 0 END) AS publies,
              SUM(CASE WHEN removed_at IS NOT NULL THEN 1 ELSE 0 END) AS retires
       FROM deals GROUP BY detector, type ORDER BY detector, type`
    )
    .all();
}

/**
 * Repasse les deals publiés au crible des règles de publication actuelles, et
 * dépublie ceux qui ne les passent plus.
 *
 * Sans cela, un durcissement des règles ne vaut que pour l'avenir : les
 * offres déjà en ligne y échappent, puisqu'elles ont été jugées à l'ancienne
 * règle. C'est ce qui laissait des promotions de marchands inconnus visibles
 * sur le site alors même que le filtre qui les écarte était déployé.
 *
 * On ne supprime rien : une offre dépubliée reste en base, et une collecte
 * ultérieure la republiera si elle redevient conforme.
 *
 * @param {(deal: object) => boolean} regle - décide si un deal reste publié
 * @returns {{examines: number, depublies: number}}
 */
function reappliquerRegles(regle) {
  const publies = db.prepare("SELECT * FROM deals WHERE published_at IS NOT NULL AND removed_at IS NULL").all();
  const depublier = db.prepare("UPDATE deals SET published_at = NULL WHERE id = ?");

  let depublies = 0;
  const lot = db.transaction((lignes) => {
    for (const ligne of lignes) {
      if (regle(enJson(ligne))) continue;
      depublier.run(ligne.id);
      depublies++;
    }
  });
  lot(publies);

  return { examines: publies.length, depublies };
}

/** Un deal par son identifiant, quel que soit son état de publication. */
function getDeal(id) {
  const row = db.prepare("SELECT * FROM deals WHERE id = ?").get(id);
  return row ? enJson(row) : null;
}

/**
 * Purge les deals retirés ou expirés depuis longtemps. La table est en
 * écriture continue (chaque passage de flux la met à jour) : sans purge elle
 * grossit indéfiniment alors que rien ne lit ces lignes.
 */
function purgerDeals(jours = 90) {
  const res = db
    .prepare(
      `DELETE FROM deals
       WHERE (removed_at IS NOT NULL AND removed_at < datetime('now', ?))
          OR (expires_at IS NOT NULL AND expires_at < datetime('now', ?))`
    )
    .run(`-${jours} days`, `-${jours} days`);
  return res.changes;
}

module.exports = {
  TYPES_DEAL,
  DETECTEURS,
  ETATS,
  versDateSql,
  upsertDeal,
  upsertDeals,
  markMissingAsRemoved,
  listDeals,
  reappliquerRegles,
  publierDeal,
  depublierDeal,
  statsDeals,
  getDeal,
  purgerDeals,
  enJson,
};
