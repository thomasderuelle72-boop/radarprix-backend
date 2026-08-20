// watch.js — Surveillance directe des fiches marchandes.
//
// Le changement de méthode qui règle le constat F1, le seul vraiment bloquant.
//
// L'approche d'origine cherchait large — une requête sur un agrégateur de
// résultats de recherche, puis comparaison entre les marchands trouvés. Elle
// souffre de deux défauts rédhibitoires pour la chasse aux erreurs de prix :
//
//  1. Le coût. Facturée à la requête, elle impose de n'observer chaque
//     produit qu'une fois toutes les seize heures. Une erreur de prix vivant
//     une vingtaine de minutes, la probabilité de la voir est de ~2 %.
//
//  2. La surface. Un agrégateur de shopping applique une politique de
//     cohérence des prix : quand le prix du flux diffère de celui de la page
//     marchande, l'article est désactivé automatiquement. C'est donc
//     précisément la surface dont les erreurs de prix sont retirées le plus
//     vite — on pêchait dans l'étang filtré exprès pour enlever les poissons
//     recherchés.
//
// Ici, on surveille des fiches précises, chez des marchands précis, en
// lisant leurs données structurées. Le coût devient de la bande passante, la
// cadence peut descendre au quart d'heure, et l'anomalie est constatée là où
// elle se produit réellement.
const { db } = require("./db");
const { extraireOffre } = require("./jsonld");
const { evaluer } = require("./anomalies");
const { isTrustedSeller } = require("./algorithm");
const { productKey } = require("./productKey");
const { upsertDeal } = require("./dealsStore");
const { scoreDesirabilite, meritePublication } = require("./curation");
const { logSourceEvent } = require("./db");

db.exec(`
  CREATE TABLE IF NOT EXISTS watched_urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    label TEXT,
    merchant TEXT,
    category TEXT NOT NULL DEFAULT 'tout',
    product_key TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    -- Compteur d'échecs consécutifs : une fiche supprimée ou protégée par un
    -- anti-robot ne doit pas être réinterrogée indéfiniment.
    echecs INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    last_price REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_watched_actives ON watched_urls(active, last_checked_at);

  -- Série de prix par fiche. C'est cette table qui permet de comparer un
  -- marchand à lui-même — le signal le plus discriminant, et celui que
  -- l'ancien modèle ne pouvait pas produire.
  CREATE TABLE IF NOT EXISTS watched_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url_id INTEGER NOT NULL REFERENCES watched_urls(id) ON DELETE CASCADE,
    price REAL NOT NULL,
    in_stock INTEGER,
    observed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_watched_prices ON watched_prices(url_id, observed_at);
`);

/** Nom de domaine d'une URL, pour espacer les requêtes vers un même serveur. */
function domaineDe(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Ajoute (ou réactive) une fiche à surveiller. */
function ajouterUrl({ url, label = null, merchant = null, category = "tout", produit = null }) {
  if (!domaineDe(url)) throw new Error("URL invalide.");
  db.prepare(
    `INSERT INTO watched_urls (url, label, merchant, category, product_key)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       label = excluded.label,
       merchant = excluded.merchant,
       category = excluded.category,
       product_key = excluded.product_key,
       active = 1,
       echecs = 0`
  ).run(
    url,
    label,
    merchant || domaineDe(url),
    category,
    produit ? productKey(produit) : label ? productKey(label) : null
  );
  return db.prepare("SELECT * FROM watched_urls WHERE url = ?").get(url);
}

function retirerUrl(id) {
  db.prepare("UPDATE watched_urls SET active = 0 WHERE id = ?").run(id);
}

function listerUrls({ actives = true, limit = 200 } = {}) {
  return db
    .prepare(
      `SELECT * FROM watched_urls ${actives ? "WHERE active = 1" : ""}
       ORDER BY last_checked_at IS NOT NULL, last_checked_at ASC LIMIT ?`
    )
    .all(limit);
}

/**
 * Le lot à interroger maintenant : les fiches vues il y a le plus longtemps
 * d'abord. Une rotation simple suffit ici, contrairement au scan payant où
 * chaque requête compte — c'est justement l'intérêt d'une source gratuite.
 */
function prochainLot(taille = 40) {
  return db
    .prepare(
      `SELECT * FROM watched_urls
       WHERE active = 1 AND echecs < 5
       ORDER BY last_checked_at IS NOT NULL, last_checked_at ASC
       LIMIT ?`
    )
    .all(taille);
}

/** Historique récent d'une fiche, pour la comparaison intra-marchand. */
function historiqueFiche(urlId, { heures = 168, limit = 200 } = {}) {
  return db
    .prepare(
      `SELECT price, observed_at AS scraped_at FROM watched_prices
       WHERE url_id = ? AND observed_at > datetime('now', ?)
       ORDER BY observed_at DESC LIMIT ?`
    )
    .all(urlId, `-${heures} hours`, limit);
}

/**
 * Référence entre marchands pour un produit donné : le dernier prix connu de
 * chaque AUTRE fiche portant la même clé produit. Une observation par
 * marchand, pour qu'un marchand interrogé plus souvent ne pèse pas davantage.
 */
function prixDesPairs(productKeyValeur, urlIdExclue) {
  if (!productKeyValeur) return [];
  return db
    .prepare(
      `SELECT w.id, (
         SELECT p.price FROM watched_prices p
         WHERE p.url_id = w.id ORDER BY p.observed_at DESC LIMIT 1
       ) AS prix
       FROM watched_urls w
       WHERE w.product_key = ? AND w.id != ? AND w.active = 1`
    )
    .all(productKeyValeur, urlIdExclue)
    .map((r) => r.prix)
    .filter((p) => Number.isFinite(p) && p > 0);
}

/**
 * Interroge une fiche, enregistre son prix et évalue l'anomalie éventuelle.
 * @returns {Promise<object>} résumé de l'observation
 */
async function verifierFiche(fiche, { fetcher = fetch, maintenant = new Date() } = {}) {
  let html;
  try {
    const res = await fetcher(fiche.url, {
      headers: {
        // Un agent identifiable et honnête : c'est la moindre des politesses
        // vis-à-vis des serveurs interrogés, et cela permet aux marchands de
        // nous contacter plutôt que de nous bloquer en silence.
        "User-Agent": "RadarPrixBot/1.0 (+https://radarprix.fr/bot)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    db.prepare("UPDATE watched_urls SET echecs = echecs + 1, last_checked_at = datetime('now') WHERE id = ?").run(fiche.id);
    return { url: fiche.url, ok: false, erreur: e.message };
  }

  const offre = extraireOffre(html);
  if (!offre || !(offre.price > 0)) {
    db.prepare("UPDATE watched_urls SET echecs = echecs + 1, last_checked_at = datetime('now') WHERE id = ?").run(fiche.id);
    return { url: fiche.url, ok: false, erreur: "aucun prix structuré trouvé" };
  }

  // Historique AVANT insertion : sinon le prix qu'on vient de relever
  // ferait partie de son propre passé et écraserait le décrochage.
  const passe = historiqueFiche(fiche.id);

  db.prepare("INSERT INTO watched_prices (url_id, price, in_stock) VALUES (?, ?, ?)").run(
    fiche.id,
    offre.price,
    offre.inStock == null ? null : offre.inStock ? 1 : 0
  );
  db.prepare("UPDATE watched_urls SET echecs = 0, last_checked_at = datetime('now'), last_price = ? WHERE id = ?").run(
    offre.price,
    fiche.id
  );

  // Une offre en rupture n'est pas une affaire : on l'observe pour
  // l'historique, mais on ne la publie jamais.
  if (offre.inStock === false) {
    return { url: fiche.url, ok: true, prix: offre.price, enStock: false, verdict: "normal" };
  }

  const pairs = prixDesPairs(fiche.product_key, fiche.id);
  const reference = pairs.length > 0 ? mediane(pairs) : medianeOuNull(passe.map((p) => p.price));
  if (!(reference > 0)) {
    return { url: fiche.url, ok: true, prix: offre.price, verdict: "normal", raison: "pas de référence" };
  }

  const evaluation = evaluer({
    prix: offre.price,
    reference,
    prixDesPairs: pairs,
    historiqueMarchand: passe,
    titre: offre.name || fiche.label,
    vendeurConnu: isTrustedSeller(fiche.merchant),
    maintenant,
  });

  if (evaluation.verdict !== "normal") {
    publierAnomalie(fiche, offre, reference, evaluation);
  }

  return { url: fiche.url, ok: true, prix: offre.price, reference, ...evaluation };
}

function mediane(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function medianeOuNull(nums) {
  const valides = nums.filter((n) => Number.isFinite(n) && n > 0);
  return valides.length >= 3 ? mediane(valides) : null;
}

/** Écrit une anomalie confirmée dans le flux public. */
function publierAnomalie(fiche, offre, reference, evaluation) {
  const deal = {
    source: "watch",
    externalId: String(fiche.id),
    detector: "D3",
    type: evaluation.verdict === "erreur" ? "erreur" : "promo",
    title: offre.name || fiche.label || fiche.url,
    url: fiche.url,
    imageUrl: offre.image || null,
    merchant: fiche.merchant,
    category: fiche.category || "tout",
    itemCondition: "neuf",
    price: offre.price,
    referencePrice: reference,
    discountPct: evaluation.pct,
    currency: offre.currency || "EUR",
    // La vraisemblance issue du faisceau de signatures tient lieu de
    // confiance : elle dit à quel point CETTE détection est solide.
    confidence: evaluation.vraisemblance,
    payload: {
      zScore: evaluation.z,
      signatures: evaluation.signatures,
      gtin: offre.gtin || null,
      sourceExtraction: offre.source,
    },
  };

  const score = scoreDesirabilite(deal);
  const publier = meritePublication(deal, score);
  upsertDeal({
    ...deal,
    score,
    publishedAt: publier ? new Date().toISOString().slice(0, 19).replace("T", " ") : null,
  });
}

/**
 * Parcourt un lot de fiches. Les requêtes vers un même domaine sont espacées :
 * marteler un serveur marchand est le meilleur moyen de se faire bloquer, et
 * ce n'est pas correct vis-à-vis de sites qu'on interroge gratuitement.
 */
async function surveiller({ taille = null, fetcher = fetch, delaiMs = null } = {}) {
  const lot = prochainLot(taille || parseInt(process.env.WATCH_BATCH_SIZE || "40", 10));
  const attente = delaiMs ?? parseInt(process.env.WATCH_DELAI_MS || "1200", 10);
  const dernierAppelParDomaine = new Map();
  const resultats = [];

  for (const fiche of lot) {
    const domaine = domaineDe(fiche.url);
    const precedent = dernierAppelParDomaine.get(domaine);
    if (precedent != null) {
      const reste = attente - (Date.now() - precedent);
      if (reste > 0) await new Promise((r) => setTimeout(r, reste));
    }
    dernierAppelParDomaine.set(domaine, Date.now());
    resultats.push(await verifierFiche(fiche, { fetcher }));
  }

  const ok = resultats.filter((r) => r.ok).length;
  const anomalies = resultats.filter((r) => r.verdict && r.verdict !== "normal").length;
  if (lot.length > 0) {
    logSourceEvent("watch", ok > 0, `${ok}/${lot.length} fiche(s) lue(s), ${anomalies} anomalie(s)`);
  }
  return resultats;
}

module.exports = {
  ajouterUrl,
  retirerUrl,
  listerUrls,
  prochainLot,
  verifierFiche,
  surveiller,
  historiqueFiche,
  prixDesPairs,
  domaineDe,
};
