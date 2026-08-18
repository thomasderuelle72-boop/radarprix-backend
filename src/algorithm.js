// algorithm.js — Détection d'anomalies de prix, 100% algorithmique.
// Deux signaux combinés :
//  1) Comparaison "entre pairs" : les offres d'un même scan pour un même
//     produit sont comparées à leur médiane (dispo dès le 1er scan).
//  2) Comparaison "historique" : le prix est comparé à la moyenne des
//     prix déjà vus pour ce produit exact (s'améliore avec le temps).
const { priceHistoryFor } = require("./db");
const { significantWords } = require("./productKey.js");

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

/**
 * Un titre est jugé pertinent seulement si TOUS les identifiants numériques
 * de la requête (modèle, génération, capacité — ex: "15", "128", "4060")
 * s'y retrouvent, ET qu'au moins la moitié des mots textuels correspondent.
 * Les nombres sont décisifs : sans eux, "iPhone 15" et "iPhone 11" étaient
 * confondus, ce qui polluait complètement la pertinence des résultats.
 */
function titleMatchesQuery(title, query) {
  const queryWords = significantWords(query);
  if (queryWords.length === 0) return true; // requête trop vague pour filtrer, on ne bloque rien
  const titleWords = new Set(significantWords(title));

  const numericWords = queryWords.filter((w) => /\d/.test(w));
  const textWords = queryWords.filter((w) => !/\d/.test(w));

  const allNumbersPresent = numericWords.every((w) => titleWords.has(w));
  if (!allNumbersPresent) return false;

  if (textWords.length === 0) return true;
  const matches = textWords.filter((w) => titleWords.has(w)).length;
  return matches >= Math.ceil(textWords.length / 2);
}

/**
 * Retire du lot les accessoires et les produits qui ne correspondent
 * manifestement pas à la recherche, avant toute analyse de prix.
 */
function filterRelevantOffers(offers, query) {
  return offers.filter((o) => !isAccessoryTitle(o.name) && titleMatchesQuery(o.name, query));
}

// "Même produit" = correspondance dans les deux sens (contrairement à
// titleMatchesQuery(title, query) qui n'exige la correspondance que d'un
// titre vers une requête). Utilisé pour regrouper entre elles les offres
// qui décrivent effectivement le même produit.
function sameProduct(titleA, titleB) {
  return titleMatchesQuery(titleA, titleB) && titleMatchesQuery(titleB, titleA);
}

/**
 * Regroupe les offres d'un lot par produit réel. Une recherche large
 * ("PC portable Dell") peut faire remonter plusieurs modèles différents
 * qui passent tous le filtre de pertinence (relevant à la requête) sans
 * être le même produit entre eux — les comparer directement produirait une
 * médiane de référence qui ne correspond à aucun d'entre eux.
 */
function clusterByProduct(offers) {
  const clusters = [];
  for (const offer of offers) {
    const cluster = clusters.find((c) => sameProduct(offer.name, c[0].name));
    if (cluster) cluster.push(offer);
    else clusters.push([offer]);
  }
  return clusters;
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

  // Référence "entre pairs" calculée séparément pour chaque produit distinct
  // du lot (voir clusterByProduct) : jamais sur tout le lot mélangé, sinon
  // des modèles différents remontés par une recherche large hériteraient
  // tous d'une médiane qui ne correspond à aucun d'entre eux.
  const peerRefByOffer = new Map();
  for (const cluster of clusterByProduct(offers)) {
    if (cluster.length < 2) continue; // rien à comparer entre pairs pour un produit seul dans le lot
    const ref = trimmedMedian(cluster.map((o) => o.price));
    for (const o of cluster) peerRefByOffer.set(o, ref);
  }

  return offers.map((o) => {
    // Référence historique propre à ce produit, si elle existe. priceHistoryFor
    // indexe par product_key (voir productKey.js) plutôt que par titre exact,
    // pour que des formulations différentes du même produit partagent leur
    // historique — o.name est canonicalisé en interne.
    const history = priceHistoryFor(o.name, 0).filter((p) => p !== o.price);
    const histRef = history.length >= 3 ? mean(history) : null;

    // "Prix le plus bas jamais vu" : vrai seulement s'il y a un historique
    // pour comparer (sinon toute première observation serait trivialement "la plus basse").
    const allTimeLow = history.length >= 3 && o.price < Math.min(...history);

    // On prend la référence la plus fiable disponible : l'historique du
    // produit s'il y en a assez, sinon la médiane rognée entre pairs du
    // même produit dans ce scan. Sans l'un ou l'autre, aucune base de
    // comparaison fiable n'existe : on ne peut pas affirmer une anomalie.
    const peerRef = peerRefByOffer.get(o) || null;
    const refPrice = histRef || peerRef;
    if (!refPrice) {
      return { ...o, refPrice: null, pct: 0, verdict: "normal", score: 0, allTimeLow: false };
    }
    const pct = Math.round((1 - o.price / refPrice) * 100);

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

    return { ...o, refPrice: Math.round(refPrice), pct, verdict, score, allTimeLow };
  });
}

module.exports = { analyzeOffers, filterRelevantOffers, median, mean, trimmedMedian, isAccessoryTitle, titleMatchesQuery, sameProduct, clusterByProduct };
