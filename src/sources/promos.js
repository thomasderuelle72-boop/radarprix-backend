// sources/promos.js — Détecteur D1 : promotions et codes promo.
//
// C'est le gisement principal du projet, et il était totalement inexploité.
// Les réseaux d'affiliation publient deux familles de flux : les catalogues
// produits (prix unitaires) et les OFFRES — promotions, ventes flash, codes
// de réduction, offres de remboursement. La seconde famille est précisément
// ce qu'une plateforme communautaire de bons plans diffuse, sauf qu'elle est
// fournie officiellement par les marchands, gratuitement, en temps réel, et
// accompagnée des liens affiliés qui financent le site.
//
// Un code promo ne modifie pas le prix affiché : aucune surveillance de prix,
// si fine soit-elle, ne peut le détecter. Ces flux sont le seul moyen.
//
// ⚠️ Avertissement d'intégration : les schémas exacts de réponse n'ont pas pu
// être vérifiés contre les APIs réelles (elles exigent des identifiants
// d'éditeur). Les fonctions de normalisation acceptent donc plusieurs
// nommages plausibles pour chaque champ et sont testées isolément. À
// confronter à une vraie réponse dès l'obtention des accès.

const { versDateSql } = require("../dealsStore");

/** Première valeur non vide parmi plusieurs noms de champs possibles. */
function champ(obj, ...noms) {
  for (const n of noms) {
    const v = obj?.[n];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/** Nombre exploitable, quel que soit le format d'origine ("12,50 €", "12.5"). */
function nombre(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = parseFloat(v.replace(/[^\d,.-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// Rattachement aux catégories du site. Les réseaux d'affiliation utilisent
// leurs propres nomenclatures, souvent en anglais et très fines : on ramène
// au vocabulaire de RadarPrix par mots-clés, avec repli sur "tout" plutôt
// que d'inventer un rattachement douteux.
// L'ordre compte : le premier mot-clé trouvé l'emporte. Les catégories les
// plus discriminantes passent donc en premier. « Chaussures de running »
// contient à la fois "chaussure" (mode) et "running" (sport) : c'est bien du
// sport, donc sport doit être testé avant mode.
const CATEGORIES = [
  ["gaming", ["gaming", "jeux vidéo", "jeux video", "console", "video game"]],
  ["sport", ["sport", "fitness", "outdoor", "running", "vélo", "velo", "bike", "randonnée", "randonnee"]],
  ["auto", ["auto", "voiture", "car", "moto", "automotive"]],
  ["hightech", ["high-tech", "hightech", "electronics", "informatique", "téléphonie", "telephonie", "computer", "phone"]],
  ["beaute", ["beauté", "beaute", "beauty", "cosmétique", "cosmetique", "parfum", "health"]],
  ["alimentaire", ["alimentaire", "food", "grocery", "épicerie", "epicerie", "boisson", "drink"]],
  ["maison", ["maison", "home", "électroménager", "electromenager", "jardin", "garden", "furniture", "meuble"]],
  ["mode", ["mode", "fashion", "clothing", "vêtement", "vetement", "chaussure", "shoes"]],
];

function categoriser(...textes) {
  const t = textes.filter(Boolean).join(" ").toLowerCase();
  for (const [cat, motsCles] of CATEGORIES) {
    if (motsCles.some((m) => t.includes(m))) return cat;
  }
  return "tout";
}

/**
 * Extrait un pourcentage de remise DÉCLARÉ par le marchand.
 *
 * À ne surtout pas confondre avec une remise mesurée : celle-ci est calculée
 * contre une référence que RadarPrix a lui-même observée. Une remise
 * déclarée sert à informer, pas à classer — c'est pourquoi ces deals sont
 * enregistrés sans referencePrice, ce qui plafonne leur score dans
 * curation.js et les place systématiquement derrière une anomalie mesurée.
 */
function remiseDeclaree(...textes) {
  const t = textes.filter(Boolean).join(" ");
  // Le refus d'un chiffre juste avant la capture est indispensable : sans
  // lui, "-150%" laisse la regex accrocher les deux derniers chiffres et
  // renvoyer une remise de 50 % parfaitement crédible mais fausse.
  const m = t.match(/(?<!\d)(\d{1,3})\s*%/);
  if (!m) return null;
  const pct = parseInt(m[1], 10);
  return pct > 0 && pct < 100 ? pct : null;
}

/**
 * Normalise une offre Strackr vers le modèle deals.
 * Strackr agrège 54 réseaux et harmonise déjà les champs, ce qui en fait le
 * point d'entrée le moins coûteux pour démarrer.
 */
function normaliserDealStrackr(raw) {
  const id = champ(raw, "id", "deal_id", "dealId");
  const titre = champ(raw, "title", "name", "description");
  if (!id || !titre) return null;

  const code = champ(raw, "code", "voucher_code", "voucherCode", "coupon");
  const marchand = champ(raw, "advertiser", "advertiser_name", "merchant", "advertiserName");
  const description = champ(raw, "description", "details", "subtitle");
  const categorie = categoriser(champ(raw, "category", "categories"), titre, description);

  return {
    source: "strackr",
    externalId: id,
    detector: "D1",
    // Un code à saisir et une promotion automatique ne se consomment pas de
    // la même façon côté acheteur : le site doit pouvoir les distinguer.
    type: code ? "code" : "promo",
    title: titre,
    description,
    url: champ(raw, "tracking_url", "trackingUrl", "url", "link"),
    imageUrl: champ(raw, "image", "image_url", "imageUrl", "logo"),
    merchant: marchand,
    category: categorie,
    voucherCode: code,
    price: nombre(champ(raw, "price", "sale_price")),
    // Volontairement absent : voir remiseDeclaree.
    referencePrice: null,
    discountPct: remiseDeclaree(titre, description, champ(raw, "discount")),
    startsAt: champ(raw, "start_date", "startDate", "valid_from"),
    expiresAt: champ(raw, "end_date", "endDate", "valid_to", "expires_at"),
    payload: raw,
  };
}

/**
 * Normalise une promotion Awin. L'Offers API expose aussi les offres
 * d'annonceurs auxquels l'éditeur n'est pas encore affilié, ce qui permet de
 * couvrir large avant d'être accepté par chaque programme.
 */
function normaliserOffreAwin(raw) {
  const id = champ(raw, "promotionId", "id");
  const titre = champ(raw, "title", "description", "name");
  if (!id || !titre) return null;

  const code = champ(raw, "voucherCode", "code");
  const marchand = raw?.advertiser?.name || champ(raw, "advertiserName", "advertiser");
  const description = champ(raw, "description", "terms");

  return {
    source: "awin",
    externalId: id,
    detector: "D1",
    type: champ(raw, "type") === "voucher" || code ? "code" : "promo",
    title: titre,
    description,
    url: raw?.urlTracking || champ(raw, "url", "deepLink", "landingPage"),
    imageUrl: champ(raw, "imageUrl", "image"),
    merchant: marchand,
    category: categoriser(champ(raw, "categories", "category"), titre, description),
    voucherCode: code,
    price: null,
    referencePrice: null,
    discountPct: remiseDeclaree(titre, description),
    startsAt: raw?.startDate || null,
    expiresAt: raw?.endDate || null,
    payload: raw,
  };
}

/** Déballe les formes d'enveloppe les plus courantes des APIs REST. */
function extraireListe(json) {
  if (Array.isArray(json)) return json;
  for (const cle of ["deals", "data", "results", "offers", "promotions", "items"]) {
    if (Array.isArray(json?.[cle])) return json[cle];
  }
  return [];
}

/**
 * Interroge Strackr. Identifiants dans STRACKR_API_ID / STRACKR_API_KEY.
 * Sans clé, la source est simplement ignorée (voir sources/index.js).
 */
async function fetchStrackrDeals({ fetcher = fetch } = {}) {
  const id = process.env.STRACKR_API_ID;
  const cle = process.env.STRACKR_API_KEY;
  if (!cle) throw new Error("STRACKR_API_KEY manquante");

  const params = new URLSearchParams({ api_id: id || "", api_key: cle });
  const res = await fetcher(`https://api.strackr.com/v3/tools/deals?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Strackr a répondu ${res.status}`);

  return extraireListe(await res.json()).map(normaliserDealStrackr).filter(Boolean);
}

/**
 * Interroge l'Offers API d'Awin. Jeton dans AWIN_API_TOKEN, identifiant
 * d'éditeur dans AWIN_PUBLISHER_ID.
 */
async function fetchAwinOffers({ fetcher = fetch } = {}) {
  const jeton = process.env.AWIN_API_TOKEN;
  const editeur = process.env.AWIN_PUBLISHER_ID;
  if (!jeton) throw new Error("AWIN_API_TOKEN manquant");
  if (!editeur) throw new Error("AWIN_PUBLISHER_ID manquant");

  const res = await fetcher(`https://api.awin.com/publishers/${editeur}/offers`, {
    headers: { Authorization: `Bearer ${jeton}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Awin a répondu ${res.status}`);

  return extraireListe(await res.json()).map(normaliserOffreAwin).filter(Boolean);
}

module.exports = {
  normaliserDealStrackr,
  normaliserOffreAwin,
  fetchStrackrDeals,
  fetchAwinOffers,
  categoriser,
  remiseDeclaree,
  extraireListe,
  nombre,
  versDateSql,
};
