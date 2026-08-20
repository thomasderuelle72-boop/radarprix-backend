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
  let pct = Number.isFinite(deal.discountPct) ? deal.discountPct : null;
  if (pct == null && prix != null && ref != null && ref > 0) {
    pct = Math.round((1 - prix / ref) * 100);
  }
  if (pct != null && pct > 0) score += Math.min(pct, 80) * 0.5; // max 40

  // ── 2. Montant économisé ──────────────────────────────────────
  // log10 : chaque multiplication par dix de l'économie rapporte le même
  // gain. 10 € → 10 pts, 100 € → 20, 1 000 € → 30, sans jamais écraser le
  // reste du score.
  if (prix != null && ref != null && ref > prix) {
    const economie = ref - prix;
    score += Math.min(Math.log10(1 + economie) * 10, 30);
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

/**
 * Un deal mérite-t-il d'être publié automatiquement ?
 *
 * Les sources déterministes (D2 : un jeu est offert ou non) court-circuitent
 * le seuil : il n'y a rien à juger, et les faire passer par un score les
 * ferait disparaître pour un prix habituel non renseigné.
 */
function meritePublication(deal, score = null) {
  if (deal.detector === "D2") return true;

  // Une offre déjà expirée ne mérite jamais d'être publiée, quel que soit
  // son score — c'est le premier motif de déception d'un site de bons plans.
  if (deal.expiresAt && new Date(deal.expiresAt) <= new Date()) return false;

  const s = score == null ? scoreDesirabilite(deal) : score;
  return s >= SEUIL_PUBLICATION;
}

module.exports = { scoreDesirabilite, meritePublication, SEUIL_PUBLICATION, BONUS_TYPE };
