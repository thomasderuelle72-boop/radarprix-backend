// anomalies.js — Reconnaître une erreur de prix à sa FORME, pas à son ampleur.
//
// Le détecteur d'origine ne connaissait qu'un critère : l'écart au prix de
// référence, en pourcentage. Cela pose deux problèmes de fond.
//
// D'abord, le pourcentage seul ne dit pas grand-chose : −60 % arrive en
// permanence sur des petits prix et jamais sur du gros électroménager. C'est
// le z-score robuste (voir madNormalise dans algorithm.js) qui règle ce
// point, en exprimant l'écart en unités de dispersion du produit lui-même.
//
// Ensuite, et c'est le plus gênant pour un produit qui s'appelle RadarPrix :
// une vraie erreur de prix a une FORME reconnaissable, que l'algorithme
// ignorait totalement. Une virgule décalée — 449 € saisi 44,90 € — produit
// un écart de −90 %. Or le code retirait 20 points de confiance à tout écart
// supérieur à 80 %. La signature la plus caractéristique de la cible était
// donc traitée comme un motif de méfiance.
//
// Ce module rassemble ces signatures. Chacune rapporte ou retire de la
// vraisemblance, et c'est le faisceau — jamais l'amplitude seule — qui
// décide qu'un prix est une erreur plutôt qu'une promotion agressive.

const { median, madNormalise, coefficientOfVariation } = require("./algorithm");

// Seuils exprimés en écarts robustes. Un même seuil vaut alors pour toutes
// les catégories et toutes les gammes de prix, sans réglage manuel.
const Z_DEAL = 3.5;
const Z_ERREUR = 6;

/**
 * Décalage de virgule : le prix vaut environ un dixième ou un centième de la
 * référence. C'est la faute de saisie la plus courante, et la signature la
 * plus fiable d'une vraie erreur de prix.
 */
function decalageDecimal(prix, reference, tolerance = 0.15) {
  if (!(prix > 0) || !(reference > 0)) return null;
  for (const facteur of [10, 100, 1000]) {
    const ecart = Math.abs(prix * facteur - reference) / reference;
    if (ecart < tolerance) return facteur;
  }
  return null;
}

/**
 * Prix plancher : 0,01 €, 1 € ou 1,00 € sur un produit à trois chiffres.
 * Typiquement un champ laissé à sa valeur par défaut, ou un produit mis en
 * ligne avant que son prix ne soit renseigné.
 */
function prixPlancher(prix, reference) {
  if (!(reference >= 50)) return false;
  return prix <= 1 || (prix < reference * 0.01);
}

/**
 * Le prix reprend un attribut du titre : capacité (128), taille (55),
 * puissance (2000), année (2024). C'est presque toujours une erreur
 * d'extraction de notre côté, pas une affaire — donc un signal NÉGATIF, qui
 * évite de publier une anomalie qu'on a fabriquée soi-même.
 */
function prixEgaleAttribut(prix, titre) {
  if (!titre || !(prix > 0)) return false;
  const nombres = String(titre).match(/\d+/g) || [];
  return nombres.some((n) => {
    const v = parseInt(n, 10);
    return v > 8 && Math.abs(v - prix) < 0.5;
  });
}

/**
 * Isolement : une seule offre décrochée alors que toutes les autres sont
 * groupées. Un marché où quinze marchands sont à ±2 % et un seul à −40 %
 * désigne bien plus sûrement une anomalie qu'un marché naturellement
 * dispersé où quelqu'un est simplement moins cher.
 */
function estIsole(prix, prixDesPairs, seuilCv = 0.06) {
  const autres = prixDesPairs.filter((p) => p !== prix);
  if (autres.length < 3) return false;
  const cv = coefficientOfVariation(autres);
  if (cv > seuilCv) return false; // les autres ne sont pas assez groupés
  const med = median(autres);
  return prix < med * 0.85;
}

/**
 * Décrochage intra-marchand : le MÊME vendeur, sur le MÊME produit, affichait
 * un prix bien supérieur il y a peu.
 *
 * C'est le signal le plus discriminant qui existe, et il n'était pas exploité
 * du tout — l'algorithme comparait toujours une offre à d'AUTRES offres,
 * jamais à elle-même la veille. Comparé à son propre passé, un prix ne peut
 * pas être victime d'un mauvais rapprochement de variante, d'un accessoire
 * mal filtré ou d'une confusion neuf/reconditionné : c'est le même vendeur et
 * le même article.
 *
 * @param {number} prix - prix courant
 * @param {Array} historiqueDuMarchand - [{price, scraped_at}, …] du même vendeur
 * @param {object} [opts]
 * @returns {object|null} { chute, ancienPrix, heures } si décrochage
 */
function decrochageMarchand(prix, historiqueDuMarchand, { chuteMin = 0.5, fenetreHeures = 48, maintenant = new Date() } = {}) {
  if (!historiqueDuMarchand || historiqueDuMarchand.length === 0) return null;

  const recents = historiqueDuMarchand
    .map((r) => ({ prix: r.price, quand: parseDateSql(r.scraped_at) }))
    .filter((r) => Number.isFinite(r.prix) && r.prix > 0)
    .filter((r) => (maintenant - r.quand) / 3600000 <= fenetreHeures)
    .filter((r) => r.prix !== prix);

  if (recents.length === 0) return null;

  // Médiane du passé récent du marchand, pas son maximum : une observation
  // aberrante dans son propre historique ne doit pas fabriquer un décrochage.
  const ancien = median(recents.map((r) => r.prix));
  if (!(ancien > 0) || prix >= ancien) return null;

  const chute = 1 - prix / ancien;
  if (chute < chuteMin) return null;

  const plusRecent = recents.reduce((a, b) => (b.quand > a.quand ? b : a));
  return {
    chute: Number(chute.toFixed(3)),
    ancienPrix: ancien,
    heures: Number(((maintenant - plusRecent.quand) / 3600000).toFixed(1)),
  };
}

function parseDateSql(s) {
  if (!s) return new Date(0);
  const t = String(s);
  const d = new Date(t.replace(" ", "T") + (t.endsWith("Z") ? "" : "Z"));
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

/**
 * Évalue un prix suspect à la lumière de toutes les signatures.
 *
 * @param {object} ctx
 * @param {number} ctx.prix - prix livré observé
 * @param {number} ctx.reference - référence observée
 * @param {Array<number>} [ctx.prixDesPairs] - prix des autres marchands du jour
 * @param {Array} [ctx.historiqueMarchand] - passé récent du même vendeur
 * @param {string} [ctx.titre]
 * @param {boolean} [ctx.vendeurConnu]
 * @returns {object} { verdict, vraisemblance, z, signatures }
 */
function evaluer({ prix, reference, prixDesPairs = [], historiqueMarchand = [], titre = null, vendeurConnu = false, maintenant = new Date() }) {
  const signatures = [];
  let vraisemblance = 0;

  const mad = madNormalise(prixDesPairs);
  const z = mad > 0 ? (reference - prix) / mad : null;

  // ── Signaux positifs ──────────────────────────────────────────
  const decrochage = decrochageMarchand(prix, historiqueMarchand, { maintenant });
  if (decrochage) {
    // Le signal le plus fort du module, et son ampleur compte : un marchand
    // qui baisse de moitié fait peut-être une promotion agressive ; un
    // marchand qui divise son propre prix par dix, sur sa propre fiche, ne
    // fait pas une promotion. Le second cas se suffit donc à lui-même pour
    // conclure à l'erreur, sans attendre d'autre confirmation.
    const poids = decrochage.chute >= 0.7 ? 60 : 45;
    vraisemblance += poids;
    signatures.push({ nom: "decrochage_marchand", poids, detail: decrochage });
  }

  const facteur = decalageDecimal(prix, reference);
  if (facteur) {
    vraisemblance += 40;
    signatures.push({ nom: "decalage_decimal", poids: 40, detail: { facteur } });
  }

  if (estIsole(prix, prixDesPairs)) {
    vraisemblance += 20;
    signatures.push({ nom: "isolement", poids: 20 });
  }

  if (prixPlancher(prix, reference)) {
    vraisemblance += 15;
    signatures.push({ nom: "prix_plancher", poids: 15 });
  }

  if (vendeurConnu) {
    // Une erreur chez une grande enseigne est plus crédible — et bien plus
    // exploitable — qu'un prix cassé chez un vendeur dont on ne sait rien.
    vraisemblance += 10;
    signatures.push({ nom: "vendeur_connu", poids: 10 });
  }

  // ── Signaux négatifs ──────────────────────────────────────────
  if (prixEgaleAttribut(prix, titre)) {
    vraisemblance -= 40;
    signatures.push({ nom: "prix_egale_attribut", poids: -40 });
  }

  // Un écart énorme SANS aucune signature reconnue reste suspect : c'est
  // alors bien plus probablement un mauvais rapprochement de produits qu'une
  // erreur de prix. La pénalité ne s'applique qu'à ce cas — contrairement au
  // code d'origine, qui l'appliquait à tous les grands écarts et sanctionnait
  // donc au premier chef les vraies erreurs de prix.
  const aSignaturePositive = signatures.some((s) => s.poids > 0 && s.nom !== "vendeur_connu");
  const ecartPct = reference > 0 ? 1 - prix / reference : 0;
  if (ecartPct >= 0.8 && !aSignaturePositive) {
    vraisemblance -= 25;
    signatures.push({ nom: "ecart_enorme_sans_signature", poids: -25 });
  }

  vraisemblance = Math.max(0, Math.min(100, Math.round(vraisemblance)));

  // ── Verdict ───────────────────────────────────────────────────
  // Deux voies vers « erreur » : un écart statistiquement extrême, ou un
  // faisceau de signatures convaincant. La seconde permet de reconnaître une
  // erreur là où la dispersion du marché est trop faible pour être mesurée
  // (un seul autre marchand, par exemple).
  let verdict = "normal";
  if (z != null && z >= Z_ERREUR && vraisemblance >= 40) verdict = "erreur";
  else if (vraisemblance >= 60) verdict = "erreur";
  else if (z != null && z >= Z_DEAL) verdict = "deal";
  else if (ecartPct >= 0.4 && vraisemblance >= 30) verdict = "deal";

  return {
    verdict,
    vraisemblance,
    z: z == null ? null : Number(z.toFixed(2)),
    pct: Math.round(ecartPct * 100),
    signatures,
  };
}

module.exports = {
  evaluer,
  decalageDecimal,
  prixPlancher,
  prixEgaleAttribut,
  estIsole,
  decrochageMarchand,
  Z_DEAL,
  Z_ERREUR,
};
