// sources/scraper.js — Données produit structurées, sans écrire de scraper.
//
// Le point faible de la découverte maison est identifié : elle repose sur des
// motifs d'URL et sur la présence de JSON-LD dans la page. Les deux varient
// d'un marchand à l'autre, cassent à chaque refonte de site, et ne peuvent
// pas être validés depuis un environnement qui n'atteint aucun marchand.
//
// Bright Data entretient plus de quatre cents extracteurs déjà écrits, un par
// site, qui rendent du JSON structuré. Le contrat se déplace : on ne maintient
// plus de sélecteurs, on consomme un format stable.
//
// ⚠️ L'API est ASYNCHRONE, et c'est structurant. On déclenche une collecte,
// elle rend un identifiant d'instantané, et les données arrivent plus tard —
// de quelques secondes à plusieurs minutes selon la taille du lot. Il faut
// donc mémoriser les collectes en cours et revenir les chercher, ce qui
// explique la table ci-dessous plutôt qu'un simple appel dans le cron.
const { db } = require("../db");

const BASE = "https://api.brightdata.com/datasets/v3";

db.exec(`
  CREATE TABLE IF NOT EXISTS collectes_scraper (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id TEXT NOT NULL UNIQUE,
    dataset_id TEXT NOT NULL,
    marchand TEXT,
    categorie TEXT NOT NULL DEFAULT 'tout',
    -- 'en_cours' | 'recuperee' | 'echouee'
    etat TEXT NOT NULL DEFAULT 'en_cours',
    urls_demandees INTEGER NOT NULL DEFAULT 0,
    produits_recus INTEGER,
    erreur TEXT,
    declenchee_a TEXT NOT NULL DEFAULT (datetime('now')),
    recuperee_a TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_collectes_etat ON collectes_scraper(etat);
`);

/**
 * Extracteurs configurés, au format "marchand:dataset_id:categorie".
 *
 * Aucune valeur par défaut, volontairement : les identifiants d'extracteur
 * (gd_XXXXXXXX) appartiennent au compte et ne se devinent pas. Les inventer
 * produirait exactement l'erreur commise sur Awin — une adresse plausible,
 * un 404, et du temps perdu à chercher la panne du mauvais côté.
 */
function extracteurs() {
  return (process.env.BRIGHT_DATA_DATASETS || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const [marchand, datasetId, categorie] = e.split(":");
      return { marchand: marchand?.trim(), datasetId: datasetId?.trim(), categorie: (categorie || "tout").trim() };
    })
    .filter((e) => e.marchand && e.datasetId);
}

function cle() {
  const k = process.env.BRIGHT_DATA_API_KEY;
  if (!k) throw new Error("BRIGHT_DATA_API_KEY absente");
  return k;
}

/**
 * Déclenche une collecte sur un lot d'adresses. Rend l'identifiant
 * d'instantané, à repasser plus tard à `recupererCollecte`.
 */
async function declencher({ datasetId, urls, marchand = null, categorie = "tout", fetcher = fetch }) {
  if (!Array.isArray(urls) || urls.length === 0) throw new Error("Aucune adresse à collecter.");

  const res = await fetcher(`${BASE}/trigger?dataset_id=${encodeURIComponent(datasetId)}&format=json`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cle()}`, "Content-Type": "application/json" },
    body: JSON.stringify(urls.map((url) => ({ url }))),
  });
  if (!res.ok) throw new Error(`Bright Data a refusé le déclenchement (${res.status})`);

  const json = await res.json();
  const snapshotId = json?.snapshot_id;
  if (!snapshotId) throw new Error("Bright Data n'a pas renvoyé d'identifiant d'instantané");

  db.prepare(
    `INSERT OR IGNORE INTO collectes_scraper (snapshot_id, dataset_id, marchand, categorie, urls_demandees)
     VALUES (?, ?, ?, ?, ?)`
  ).run(snapshotId, datasetId, marchand, categorie, urls.length);

  return snapshotId;
}

/** Collectes déclenchées dont les données n'ont pas encore été récupérées. */
function collectesEnCours() {
  return db.prepare("SELECT * FROM collectes_scraper WHERE etat = 'en_cours' ORDER BY declenchee_a").all();
}

/**
 * Récupère les données d'une collecte si elle est terminée.
 * @returns {Promise<{prete: boolean, produits: Array}>}
 */
async function recupererCollecte(snapshotId, { fetcher = fetch } = {}) {
  const res = await fetcher(`${BASE}/snapshot/${encodeURIComponent(snapshotId)}?format=json`, {
    headers: { Authorization: `Bearer ${cle()}`, Accept: "application/json" },
  });

  // 202 : la collecte tourne encore. Ce n'est pas une erreur, et la traiter
  // comme telle ferait abandonner des instantanés parfaitement valides.
  if (res.status === 202) return { prete: false, produits: [] };
  if (!res.ok) throw new Error(`Bright Data a répondu ${res.status}`);

  const json = await res.json();
  return { prete: true, produits: Array.isArray(json) ? json : json?.data || [] };
}

/** Marque une collecte comme aboutie ou perdue. */
function cloturerCollecte(snapshotId, { produits = null, erreur = null } = {}) {
  db.prepare(
    `UPDATE collectes_scraper
     SET etat = ?, produits_recus = ?, erreur = ?, recuperee_a = datetime('now')
     WHERE snapshot_id = ?`
  ).run(erreur ? "echouee" : "recuperee", produits, erreur, snapshotId);
}

/** Première valeur non vide parmi plusieurs noms de champs possibles. */
function champ(obj, ...noms) {
  for (const n of noms) {
    const v = obj?.[n];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function nombre(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = parseFloat(v.replace(/[^\d,.-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise un produit vers le modèle deals.
 *
 * Chaque extracteur a son propre vocabulaire — `final_price` chez l'un,
 * `price` chez l'autre, `product_name` ou `title` selon le site. On accepte
 * donc plusieurs nommages par champ plutôt que d'écrire un normaliseur par
 * extracteur, ce qui reviendrait à maintenir les sélecteurs qu'on cherchait
 * précisément à ne plus maintenir.
 */
function normaliserProduit(raw, { marchand = null, categorie = "tout" } = {}) {
  const url = champ(raw, "url", "product_url", "link");
  const titre = champ(raw, "title", "product_name", "name");
  const prix = nombre(champ(raw, "final_price", "price", "current_price", "sale_price"));
  if (!url || !titre || !(prix > 0)) return null;

  // Le prix barré du marchand n'est JAMAIS pris comme référence : c'est un
  // argument commercial, souvent un prix conseillé jamais pratiqué. La
  // référence de RadarPrix reste ce que RadarPrix a observé lui-même.
  const dispo = champ(raw, "availability", "in_stock", "stock_status");
  const enRupture = typeof dispo === "string" ? /out of stock|rupture|indisponible/i.test(dispo) : dispo === false;

  const images = champ(raw, "images", "image_url", "main_image", "image");

  return {
    source: "brightdata",
    externalId: String(champ(raw, "asin", "product_id", "sku", "id") || url),
    detector: "D3",
    type: "produit",
    title: titre,
    description: champ(raw, "description"),
    url,
    imageUrl: Array.isArray(images) ? images[0] || null : images,
    merchant: marchand || champ(raw, "seller_name", "brand", "domain"),
    category: categorie,
    itemCondition: "neuf",
    price: prix,
    referencePrice: null,
    currency: champ(raw, "currency") || "EUR",
    // Clé de jointure entre sources : c'est elle qui permet de comparer le
    // même produit chez plusieurs vendeurs sans dépendre des titres.
    gtin: champ(raw, "upc", "ean", "gtin", "barcode"),
    enRupture,
    payload: raw,
  };
}

module.exports = {
  declencher,
  recupererCollecte,
  cloturerCollecte,
  collectesEnCours,
  normaliserProduit,
  extracteurs,
  BASE,
};
