// curation.js — Ce qui remplace la communauté tant qu'elle n'existe pas.
//
// Le problème que ce module résout : brancher les flux d'affiliation sans
// filtre déverserait plusieurs milliers de promotions par jour, dont
// l'immense majorité sans intérêt (−5 % sur un accessoire, « livraison
// offerte dès 80 € »). Une plateforme communautaire s'en protège par le vote
// de ses membres ; un flux automatisé n'a personne. Sans garde-fou, le site
// deviendrait moins utile qu'avec un catalogue vide.
//
// Deux fonctions, volontairement pures (aucun accès base) pour rester
// testables : un score de désirabilité, et le seuil au-delà duquel un deal
// mérite d'être publié.

// Combien un type de bon plan est intrinsèquement remarquable, avant même de
// regarder son prix. Un jeu offert intéresse tout le monde ; une promotion
// ordinaire ne vaut que par sa profondeur.
const BONUS_TYPE = {
  gratuit: 25,
  erreur: 20,
  code: 8,
  odr: 8,
  occasion: 3,
  promo: 0,
};

/**
 * Remise d'un deal, qu'elle soit déclarée par la source ou déduite du couple
 * prix/référence. Une seule règle, partagée par le score et la décision de
 * publication — sinon les deux peuvent diverger sur le même deal.
 */
function remiseEffective(deal) {
  if (Number.isFinite(deal.discountPct)) return deal.discountPct;
  const prix = Number.isFinite(deal.price) ? deal.price : null;
  const ref = Number.isFinite(deal.referencePrice) ? deal.referencePrice : null;
  if (prix == null || ref == null || ref <= 0) return null;
  return Math.round((1 - prix / ref) * 100);
}

/**
 * Score de désirabilité, de 0 à 100.
 *
 * Trois signaux combinés, choisis pour être robustes à ce que les marchands
 * racontent d'eux-mêmes :
 *
 *  1. La profondeur de la remise — mais uniquement calculée contre une
 *     référence OBSERVÉE. Le prix barré du marchand n'entre jamais ici :
 *     c'est un argument commercial, souvent un prix conseillé jamais
 *     pratiqué, et l'accepter reviendrait à laisser chaque marchand décider
 *     de sa place dans le classement.
 *
 *  2. Le montant économisé en valeur absolue, sur une échelle logarithmique.
 *     C'est ce qui distingue −20 % sur un lave-linge à 700 € de −60 % sur un
 *     câble à 8 €. Le pourcentage seul classe le second devant le premier,
 *     ce qui ne correspond à aucune intuition d'acheteur.
 *
 *  3. La nature du bon plan et la fiabilité du marchand.
 *
 * @param {object} deal - au format dealsStore (price, referencePrice, type…)
 * @param {object} [opts]
 * @param {number} [opts.fiabiliteMarchand] - 0 à 1, voir merchantReliability
 * @returns {number} score entier de 0 à 100
 */
function scoreDesirabilite(deal, { fiabiliteMarchand = null } = {}) {
  const prix = Number.isFinite(deal.price) ? deal.price : null;
  const ref = Number.isFinite(deal.referencePrice) ? deal.referencePrice : null;

  let score = 0;

  // ── 1. Profondeur de la remise ────────────────────────────────
  // Plafonnée à 80 % : au-delà, l'écart en dit davantage sur la qualité de
  // la référence que sur la qualité de l'affaire.
  const pct = remiseEffective(deal);
  if (pct != null && pct > 0) score += Math.min(pct, 80) * 0.375; // max 30

  // ── 2. Montant économisé ──────────────────────────────────────
  // Pèse volontairement PLUS que le pourcentage, et c'est le point le moins
  // intuitif du barème. Un premier réglage donnait 40 points au pourcentage
  // contre 30 à l'économie : −60 % sur un câble à 8 € (4,80 € gagnés)
  // passait alors devant −20 % sur un lave-linge à 700 € (140 € gagnés).
  // Aucun acheteur ne raisonne ainsi, et c'est exactement le travers qui
  // remplit un site de bons plans d'offres sans intérêt.
  //
  // log10 : chaque multiplication par dix de l'économie rapporte le même
  // gain. 10 € → 21 pts, 100 € → 40, 1 000 € → 45 (plafond).
  if (prix != null && ref != null && ref > prix) {
    const economie = ref - prix;
    score += Math.min(Math.log10(1 + economie) * 20, 45);
  }

  // ── 3. Nature et marchand ─────────────────────────────────────
  score += BONUS_TYPE[deal.type] ?? 0;

  if (fiabiliteMarchand != null) {
    // Centré sur 0 : un marchand médiocre pénalise autant qu'un marchand
    // sûr bonifie, sinon un vendeur inconnu serait simplement neutre.
    score += (fiabiliteMarchand - 0.5) * 20; // −10 à +10
  }

  // Sans référence de prix, on ne peut pas juger de l'affaire. On plafonne
  // plutôt que d'annuler : un jeu offert reste intéressant même si son prix
  // habituel n'est pas connu.
  if (ref == null && deal.type !== "gratuit") score = Math.min(score, 35);

  return Math.max(0, Math.min(100, Math.round(score)));
}

// Un deal en dessous de ce score n'atteint pas le flux public. Réglé pour
// laisser passer une remise significative sur un produit d'un certain prix,
// et bloquer les « −5 % » qui composent le gros des flux d'affiliation.
const SEUIL_PUBLICATION = 30;

// Seuils propres aux offres dont on ne connaît QUE la remise annoncée.
const SEUIL_REMISE_DECLAREE = 20;
// Un code promo est retenu plus bas : il est directement actionnable, se
// cumule souvent avec une promotion en cours, et 10 % au panier est un
// avantage que les acheteurs utilisent réellement.
const SEUIL_REMISE_CODE = 10;

/**
 * Un deal mérite-t-il d'être publié automatiquement ?
 *
 * La règle dépend de ce qu'on peut réellement savoir du deal — d'où trois
 * branches plutôt qu'un seuil unique :
 *
 *  • D2 (gratuit) : déterministe. Un jeu est offert ou il ne l'est pas ; il
 *    n'y a rien à juger, et passer par un score le ferait disparaître au
 *    seul motif que son prix habituel n'est pas renseigné.
 *
 *  • D1 (promotions, codes promo) : un flux d'affiliation ne fournit ni prix
 *    ni référence observée. Le score, qui repose surtout là-dessus, vaut donc
 *    presque zéro pour ces offres — l'appliquer tel quel bloquait la
 *    TOTALITÉ du détecteur, c'est-à-dire précisément la source de volume du
 *    site. On juge donc sur la seule information disponible : la profondeur
 *    de la remise annoncée. Le plafond de score reste, lui, en place : il
 *    gouverne le CLASSEMENT, et garde ces offres derrière les anomalies
 *    réellement mesurées.
 *
 *  • D3/D4 (anomalies mesurées) : le score complet s'applique, puisque toute
 *    l'information est là.
 *
 * Limite assumée : une offre non chiffrée (« livraison offerte dès 25 € »)
 * n'est pas publiée automatiquement. Faute de pouvoir la comparer à quoi que
 * ce soit, mieux vaut la laisser de côté que remplir le flux d'offres qu'on
 * ne sait pas classer.
 */
function meritePublication(deal, score = null) {
  if (deal.detector === "D2") return true;

  // Une offre déjà expirée ne mérite jamais d'être publiée, quel que soit
  // son score — c'est le premier motif de déception d'un site de bons plans.
  if (deal.expiresAt && new Date(deal.expiresAt) <= new Date()) return false;

  if (deal.detector === "D1") {
    const pct = remiseEffective(deal);
    if (pct == null) return false;
    return pct >= (deal.type === "code" ? SEUIL_REMISE_CODE : SEUIL_REMISE_DECLAREE);
  }

  const s = score == null ? scoreDesirabilite(deal) : score;
  return s >= SEUIL_PUBLICATION;
}

module.exports = {
  scoreDesirabilite,
  meritePublication,
  remiseEffective,
  SEUIL_PUBLICATION,
  SEUIL_REMISE_DECLAREE,
  SEUIL_REMISE_CODE,
  BONUS_TYPE,
};
