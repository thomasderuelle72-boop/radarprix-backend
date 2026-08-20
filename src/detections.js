// detections.js — Pont entre le détecteur d'anomalies (D3/D4) et le flux public.
//
// Auparavant, la route /api/deals relisait tous les lots enregistrés, les
// refiltrait et les réanalysait à chaque visiteur : quelques milliers de
// requêtes SQL synchrones par appel, dans le thread principal, sur la page la
// plus consultée du site. L'analyse appartient au producteur, pas au lecteur :
// le verdict est désormais calculé une fois, au moment du scan, et écrit dans
// la table `deals` que la lecture se contente de paginer.
const { upsertDeal } = require("./dealsStore");
const { scoreDesirabilite, meritePublication } = require("./curation");
const { analyzeOffers } = require("./algorithm");
const { productKey } = require("./productKey");
const { fiabilite } = require("./reputation");

/**
 * Identifiant stable d'une détection.
 *
 * Le couple produit + marchand, et non le prix : une même offre revue à un
 * prix différent est la même détection mise à jour, pas une nouvelle. Sans
 * cela, chaque passage du scan créerait une ligne de plus pour la même offre.
 */
function identifiantDetection(offre) {
  return `${productKey(offre.name)}|${(offre.seller || "inconnu").toLowerCase()}`;
}

/**
 * Écrit les anomalies d'un lot analysé dans le flux.
 *
 * @param {string} category - catégorie du site
 * @param {Array} analysees - sortie de analyzeOffers
 * @returns {{ecrits: number, publies: number}}
 */
function enregistrerDetections(category, analysees) {
  let ecrits = 0;
  let publies = 0;

  for (const o of analysees) {
    if (o.verdict === "normal") continue;
    if (!Number.isFinite(o.refPrice) || o.refPrice <= 0) continue;

    const deal = {
      source: "radar",
      externalId: identifiantDetection(o),
      detector: "D3",
      // « erreur » et « promo » se distinguent par l'ampleur ; le champ
      // detector conserve par ailleurs la provenance, ce qui évite de
      // confondre un prix bas mesuré par RadarPrix avec une promotion
      // annoncée par un marchand (D1).
      type: o.verdict === "erreur" ? "erreur" : "promo",
      title: o.name,
      url: o.url || null,
      imageUrl: o.img || null,
      merchant: o.seller || null,
      category: category || "tout",
      itemCondition: "neuf",
      // Prix livré : c'est celui sur lequel le verdict a été rendu.
      price: Number.isFinite(o.priceTotal) ? o.priceTotal : o.price,
      // Référence réellement observée chez les marchands, jamais un prix
      // barré : c'est ce qui autorise ce deal à être classé sur sa remise.
      referencePrice: o.refPrice,
      discountPct: o.pct,
      confidence: o.confidence,
      payload: {
        prixAffiche: o.price,
        fraisPort: o.delivery ?? null,
        zScore: o.zScore ?? null,
        allTimeLow: Boolean(o.allTimeLow),
      },
    };

    const score = scoreDesirabilite(deal, { fiabiliteMarchand: fiabilite(deal.merchant) });
    const publier = meritePublication(deal, score);
    upsertDeal({
      ...deal,
      score,
      publishedAt: publier ? new Date().toISOString().slice(0, 19).replace("T", " ") : null,
    });
    ecrits++;
    if (publier) publies++;
  }

  return { ecrits, publies };
}

/**
 * Détecteur D4 : le reconditionné, comparé à lui-même.
 *
 * Ces offres étaient purement jetées. Elles sont légitimement moins chères
 * que du neuf, donc les comparer au neuf n'a aucun sens — mais les comparer
 * entre elles en a un : c'est un marché à part entière, avec ses propres
 * anomalies de prix.
 */
function enregistrerReconditionne(category, offresReconditionnees) {
  if (!offresReconditionnees || offresReconditionnees.length === 0) {
    return { ecrits: 0, publies: 0 };
  }

  // Référence calculée au sein du seul reconditionné.
  const analysees = analyzeOffers(offresReconditionnees);
  let ecrits = 0;
  let publies = 0;

  for (const o of analysees) {
    if (o.verdict === "normal") continue;
    if (!Number.isFinite(o.refPrice) || o.refPrice <= 0) continue;

    const deal = {
      source: "radar-occasion",
      externalId: identifiantDetection(o),
      detector: "D4",
      type: "occasion",
      title: o.name,
      url: o.url || null,
      imageUrl: o.img || null,
      merchant: o.seller || null,
      category: category || "tout",
      itemCondition: o.itemCondition === "occasion" ? "occasion" : "reconditionne",
      price: Number.isFinite(o.priceTotal) ? o.priceTotal : o.price,
      referencePrice: o.refPrice,
      discountPct: o.pct,
      confidence: o.confidence,
      payload: { zScore: o.zScore ?? null },
    };

    const score = scoreDesirabilite(deal, { fiabiliteMarchand: fiabilite(deal.merchant) });
    // Le seuil de publication reste le même : une offre reconditionnée sans
    // intérêt n'a pas plus sa place dans sa section que dans le flux principal.
    const publier = meritePublication(deal, score);
    upsertDeal({
      ...deal,
      score,
      publishedAt: publier ? new Date().toISOString().slice(0, 19).replace("T", " ") : null,
    });
    ecrits++;
    if (publier) publies++;
  }

  return { ecrits, publies };
}

module.exports = { enregistrerDetections, enregistrerReconditionne, identifiantDetection };
