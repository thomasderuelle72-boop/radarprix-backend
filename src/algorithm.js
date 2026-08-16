// algorithm.js — Détection d'anomalies de prix, 100% algorithmique.
// Deux signaux combinés :
//  1) Comparaison "entre pairs" : les offres d'un même scan pour un même
//     produit sont comparées à leur médiane (dispo dès le 1er scan).
//  2) Comparaison "historique" : le prix est comparé à la moyenne des
//     prix déjà vus pour ce produit exact (s'améliore avec le temps).
const { priceHistoryFor } = require("./db");

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Analyse un lot d'offres fraîchement scannées pour un même produit/requête.
 * @param {Array} offers - [{name, price, seller, url, img}, ...]
 * @returns {Array} offres enrichies avec {refPrice, pct, verdict, score}
 */
function analyzeOffers(offers) {
  if (offers.length === 0) return [];

  const prices = offers.map((o) => o.price);
  const peerMedian = median(prices);

  return offers.map((o) => {
    // Référence historique propre à ce produit, si elle existe.
    const history = priceHistoryFor(o.name, 0).filter((p) => p !== o.price);
    const histRef = history.length >= 3 ? mean(history) : null;

    // On prend la référence la plus fiable disponible : l'historique
    // du produit s'il y en a assez, sinon la médiane du scan du jour.
    const refPrice = histRef || peerMedian;
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

module.exports = { analyzeOffers, median, mean };
