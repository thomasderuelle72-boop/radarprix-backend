// algorithm.js — Détection d'anomalies de prix, 100% algorithmique.
// Deux signaux combinés :
//  1) Comparaison "entre pairs" : les offres d'un même scan pour un même
//     produit sont comparées à leur médiane (dispo dès le 1er scan).
//  2) Comparaison "historique" : le prix est comparé à la moyenne des
//     prix déjà vus pour ce produit exact (s'améliore avec le temps).
const { priceHistoryFor } = require("./db");

// Titres à écarter d'office : ce sont presque toujours des accessoires
// (coque, chargeur...) qui portent le nom du produit recherché mais coûtent
// une fraction du prix — sans ce filtre, ils faussent complètement la
// médiane de référence et remontent comme de fausses "erreurs de prix".
const ACCESSORY_KEYWORDS = [
  "coque", "housse", "étui", "etui", "protection écran", "protège-écran",
  "verre trempé", "film de protection", "autocollant", "sticker", "skin",
  "support", "chargeur", "câble", "cable", "adaptateur", "batterie externe",
  "sacoche", "sac de transport", "pochette", "bumper",
  "manette pour", "casque pour",
];

function isAccessoryTitle(title) {
  const t = (title || "").toLowerCase();
  return ACCESSORY_KEYWORDS.some((kw) => t.includes(kw));
}

// Les mots vides ne comptent pas comme "mots significatifs" de la requête.
const STOPWORDS = new Set(["de", "du", "des", "le", "la", "les", "un", "une", "et", "pour", "avec"]);

function significantWords(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // enlève les accents
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Un titre est jugé pertinent s'il reprend au moins la moitié des mots
 * significatifs de la requête (arrondi au-dessus, minimum 1 mot).
 */
function titleMatchesQuery(title, query) {
  const queryWords = significantWords(query);
  if (queryWords.length === 0) return true; // requête trop vague pour filtrer, on ne bloque rien
  const titleWords = new Set(significantWords(title));
  const matches = queryWords.filter((w) => titleWords.has(w)).length;
  return matches >= Math.ceil(queryWords.length / 2);
}

/**
 * Retire du lot les accessoires et les produits qui ne correspondent
 * manifestement pas à la recherche, avant toute analyse de prix.
 */
function filterRelevantOffers(offers, query) {
  return offers.filter((o) => !isAccessoryTitle(o.name) && titleMatchesQuery(o.name, query));
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Médiane "rognée" : ignore le dixième le plus bas et le dixième le plus
 * haut avant de calculer la médiane, pour qu'un ou deux résultats mal
 * assortis (mauvaise variante, erreur de catégorisation Google) ne
 * faussent pas la référence de prix. Se comporte comme une médiane
 * classique sur les petits lots (moins de 5 offres).
 */
function trimmedMedian(nums) {
  if (nums.length < 5) return median(nums);
  const s = [...nums].sort((a, b) => a - b);
  const cut = Math.floor(s.length * 0.1);
  return median(s.slice(cut, s.length - cut));
}

/**
 * Analyse un lot d'offres fraîchement scannées pour un même produit/requête.
 * @param {Array} offers - [{name, price, seller, url, img}, ...]
 * @returns {Array} offres enrichies avec {refPrice, pct, verdict, score}
 */
function analyzeOffers(offers) {
  if (offers.length === 0) return [];

  const prices = offers.map((o) => o.price);
  const peerRef = trimmedMedian(prices);

  return offers.map((o) => {
    // Référence historique propre à ce produit, si elle existe.
    const history = priceHistoryFor(o.name, 0).filter((p) => p !== o.price);
    const histRef = history.length >= 3 ? mean(history) : null;

    // On prend la référence la plus fiable disponible : l'historique
    // du produit s'il y en a assez, sinon la médiane rognée du scan du jour.
    const refPrice = histRef || peerRef;
    const pct = refPrice > 0 ? Math.round((1 - o.price / refPrice) * 100) : 0;

    let verdict = "normal";
    if (pct >= 60) verdict = "erreur";
    else if (pct >= 40) verdict = "deal";

    const BIG_SELLERS = ["amazon", "cdiscount", "fnac", "ldlc", "darty", "boulanger", "materiel.net", "rakuten", "leclerc", "carrefour"];
    let score = Math.min(Math.max(pct, 0), 70);
    if (verdict === "erreur") score += 15;
    const sellerLower = (o.seller || "").toLowerCase();
    if (BIG_SELLERS.some((b) => sellerLower.includes(b))) score += 15;
    if (histRef) score += 5; // référence historique = plus fiable qu'une simple comparaison du jour
    score = Math.min(score, 100);

    return { ...o, refPrice: Math.round(refPrice), pct, verdict, score };
  });
}

module.exports = { analyzeOffers, filterRelevantOffers, median, mean, trimmedMedian, isAccessoryTitle, titleMatchesQuery };
