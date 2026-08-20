// algorithm.js — Détection d'anomalies de prix, 100% algorithmique.
// Deux signaux combinés :
//  1) Comparaison "entre pairs" : les offres d'un même scan pour un même
//     produit sont comparées à leur médiane (dispo dès le 1er scan).
//  2) Comparaison "historique" : le prix est comparé à la moyenne des
//     prix déjà vus pour ce produit exact (s'améliore avec le temps).
const { priceHistoryFor, reglages, offreBannie } = require("./db");
const { significantWords } = require("./productKey.js");

// Titres à écarter d'office : ce sont presque toujours des accessoires
// (coque, chargeur...) qui portent le nom du produit recherché mais coûtent
// une fraction du prix — sans ce filtre, ils faussent complètement la
// médiane de référence et remontent comme de fausses "erreurs de prix".
const ACCESSORY_KEYWORDS = [
  "coque", "housse", "étui", "etui", "protection écran", "protège-écran",
  "protection pour", "vitre de protection", "vitre protectrice",
  "verre trempé", "film de protection", "autocollant", "sticker", "skin",
  "support", "chargeur", "câble", "cable", "adaptateur", "batterie externe",
  "sacoche", "sac de transport", "pochette", "bumper",
  "manette pour", "casque pour",
];

function isAccessoryTitle(title) {
  const t = (title || "").toLowerCase();
  return ACCESSORY_KEYWORDS.some((kw) => t.includes(kw));
}

// Une annonce reconditionnée/d'occasion peut porter exactement le bon nom de
// modèle (elle passe donc titleMatchesQuery) tout en étant nettement moins
// chère qu'un exemplaire neuf pour des raisons qui n'ont rien à voir avec
// une erreur de prix — l'inclure dans le calcul de la référence ou la
// flagger comme "deal"/"erreur" par rapport au prix du neuf n'a pas de sens.
// On l'écarte donc par défaut, au même titre qu'un accessoire.
const USED_CONDITION_KEYWORDS = [
  "reconditionné", "reconditionne", "reconditionnée", "reconditionnee",
  "occasion", "d'occasion", "seconde main", "2ème main", "2eme main",
  "grade a", "grade b", "grade c", "état correct", "etat correct",
  "très bon état", "tres bon etat", "bon état", "bon etat",
  "refurbished", "used", "pré-owned", "preowned",
];

function isUsedOrRefurbishedTitle(title) {
  const t = (title || "").toLowerCase();
  return USED_CONDITION_KEYWORDS.some((kw) => t.includes(kw));
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
 * Retire du lot les accessoires, les annonces reconditionnées/d'occasion et
 * les produits qui ne correspondent manifestement pas à la recherche, avant
 * toute analyse de prix.
 */
function filterRelevantOffers(offers, query) {
  return offers.filter(
    (o) =>
      !isAccessoryTitle(o.name) &&
      !isUsedOrRefurbishedTitle(o.name) &&
      titleMatchesQuery(o.name, query) &&
      // Liste noire tenue à la main : elle rattrape ce que les règles
      // automatiques laissent passer — une gamme d'accessoires dont le nom
      // ressemble trop au produit, un marchand systématiquement trompeur.
      !offreBannie(o)
  );
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
 * Écarte d'un cluster les prix grossièrement aberrants (moins d'un quart ou
 * plus de 4x la médiane du groupe) avant de calculer la référence — filet de
 * sécurité si un intrus (mauvaise variante, accessoire mal filtré) passe
 * quand même le filtrage par mots-clés/titre. Rognage à 10% (trimmedMedian)
 * seul ne suffit pas sur un petit cluster : 1 intrus sur 4-5 offres n'est
 * pas retiré par un simple rognage de 10%. Renvoie la liste d'origine si le
 * filtrage éliminerait plus de la moitié des prix (signe que c'est la
 * médiane elle-même qui n'est pas fiable, pas un intrus isolé).
 */
function stripGrossOutliers(prices) {
  if (prices.length < 3) return prices;
  const roughMedian = median(prices);
  if (roughMedian === 0) return prices;
  const filtered = prices.filter((p) => p >= roughMedian * 0.25 && p <= roughMedian * 4);
  return filtered.length >= Math.ceil(prices.length / 2) ? filtered : prices;
}

// Coefficient de variation (écart-type / moyenne) : mesure la dispersion
// relative des prix d'un cluster. Un cluster serré (CV faible) rend sa
// médiane plus digne de confiance qu'un cluster où les prix partent dans
// tous les sens (mauvais rapprochements de variantes, par exemple).
function coefficientOfVariation(nums) {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  if (m === 0) return 0;
  const variance = mean(nums.map((n) => (n - m) ** 2));
  return Math.sqrt(variance) / m;
}

const BIG_SELLERS = ["amazon", "cdiscount", "fnac", "ldlc", "darty", "boulanger", "materiel.net", "rakuten", "leclerc", "carrefour"];

/**
 * Analyse un lot d'offres fraîchement scannées pour un même produit/requête.
 *
 * Deux scores distincts, volontairement séparés :
 *  - `score` (Deal Score) : à quel point le prix est intéressant. Basé
 *    uniquement sur l'écart au prix de référence.
 *  - `confidence` (Confidence Score) : à quel point on peut faire confiance
 *    à CETTE détection précise — nombre de pairs comparables, cohérence des
 *    prix entre eux, confirmation par l'historique, fiabilité du vendeur.
 *    Un écart énorme (-90%) sans aucune confirmation ne doit PAS produire
 *    la même confiance qu'un écart plus modeste confirmé par l'historique
 *    ET plusieurs vendeurs cohérents entre eux — l'un peut être une vraie
 *    pépite, l'autre plus probablement une mauvaise variante, un accessoire
 *    mal filtré, ou un prix déjà corrigé.
 *
 * @param {Array} offers - [{name, price, seller, url, img}, ...]
 * @returns {Array} offres enrichies avec {refPrice, pct, verdict, score, confidence}
 */
function analyzeOffers(offers) {
  if (offers.length === 0) return [];

  // Réglages lus une fois par lot, pas une fois par offre : ils viennent de
  // la base et sont modifiables depuis le tableau de bord.
  const R = reglages();

  // Référence "entre pairs" calculée séparément pour chaque produit distinct
  // du lot (voir clusterByProduct) : jamais sur tout le lot mélangé, sinon
  // des modèles différents remontés par une recherche large hériteraient
  // tous d'une médiane qui ne correspond à aucun d'entre eux. On garde aussi
  // la taille du cluster et la dispersion des prix, utiles au Confidence Score.
  const peerRefByOffer = new Map();
  const peerStatsByOffer = new Map();
  for (const cluster of clusterByProduct(offers)) {
    if (cluster.length < R.minPairs) continue; // pas assez de pairs comparables dans ce lot
    const prices = stripGrossOutliers(cluster.map((o) => o.price));
    const ref = trimmedMedian(prices);
    const stats = { size: prices.length, cv: coefficientOfVariation(prices) };
    for (const o of cluster) {
      peerRefByOffer.set(o, ref);
      peerStatsByOffer.set(o, stats);
    }
  }

  return offers.map((o) => {
    // Référence historique propre à ce produit, si elle existe. priceHistoryFor
    // indexe par product_key (voir productKey.js) plutôt que par titre exact,
    // pour que des formulations différentes du même produit partagent leur
    // historique — o.name est canonicalisé en interne.
    const history = priceHistoryFor(o.name, 0).filter((p) => p !== o.price);
    const histRef = history.length >= R.minHistorique ? mean(history) : null;

    // "Prix le plus bas jamais vu" : vrai seulement s'il y a un historique
    // pour comparer (sinon toute première observation serait trivialement "la plus basse").
    const allTimeLow = history.length >= R.minHistorique && o.price < Math.min(...history);

    // On prend la référence la plus fiable disponible : l'historique du
    // produit s'il y en a assez, sinon la médiane rognée entre pairs du
    // même produit dans ce scan. Sans l'un ou l'autre, aucune base de
    // comparaison fiable n'existe : on ne peut pas affirmer une anomalie.
    const peerStats = peerStatsByOffer.get(o) || null;
    const peerRef = peerRefByOffer.get(o) || null;
    const refPrice = histRef || peerRef;
    if (!refPrice) {
      return { ...o, refPrice: null, pct: 0, verdict: "normal", score: 0, confidence: null, allTimeLow: false };
    }
    const pct = Math.round((1 - o.price / refPrice) * 100);

    let verdict = "normal";
    if (pct >= R.seuilErreur) verdict = "erreur";
    else if (pct >= R.seuilDeal) verdict = "deal";

    const sellerLower = (o.seller || "").toLowerCase();
    const isTrustedSeller = BIG_SELLERS.some((b) => sellerLower.includes(b));

    // Deal Score : uniquement l'attractivité du prix.
    let score = Math.min(Math.max(pct, 0), 70);
    if (verdict === "erreur") score += 15;
    if (isTrustedSeller) score += 15;
    if (histRef) score += 5; // référence historique = plus fiable qu'une simple comparaison du jour
    score = Math.min(score, 100);

    // Confidence Score : la fiabilité de CETTE détection, indépendamment
    // de l'attractivité du prix.
    let confidence = 50;
    if (peerStats) {
      confidence += Math.min(peerStats.size - 1, 5) * 5; // jusqu'à +25 pour un groupe de pairs fourni
      if (peerStats.cv < 0.15) confidence += 10; // prix des pairs cohérents entre eux
      else if (peerStats.cv > 0.5) confidence -= 10; // pairs très dispersés = rapprochements douteux
    }
    if (histRef) confidence += 20; // confirmé par l'historique du produit, pas seulement le scan du jour
    if (pct >= 80) confidence -= 20; // écart énorme = plus probablement une erreur de rapprochement
    else if (pct >= 60) confidence -= 10;
    if (isTrustedSeller) confidence += 10;
    confidence = Math.max(0, Math.min(100, Math.round(confidence)));

    // Plancher de confiance : au-delà d'un certain doute, mieux vaut ne rien
    // annoncer qu'annoncer une anomalie qui n'en est pas une. À 0 (valeur
    // d'origine), ce filtre ne retire rien.
    if (verdict !== "normal" && confidence < R.confianceMin) verdict = "normal";

    return { ...o, refPrice: Math.round(refPrice), pct, verdict, score, confidence, allTimeLow };
  });
}

module.exports = { analyzeOffers, filterRelevantOffers, median, mean, trimmedMedian, stripGrossOutliers, coefficientOfVariation, isAccessoryTitle, isUsedOrRefurbishedTitle, titleMatchesQuery, sameProduct, clusterByProduct };
