// algorithm.js — Détection d'anomalies de prix, 100% algorithmique.
// Deux signaux combinés :
//  1) Comparaison "entre pairs" : les offres d'un même scan pour un même
//     produit sont comparées à leur médiane (dispo dès le 1er scan).
//  2) Comparaison "historique" : le prix est comparé à la moyenne des
//     prix déjà vus pour ce produit exact (s'améliore avec le temps).
const { priceHistoryBatch, reglages, offreBannie } = require("./db");
const { significantWords, estMarqueurVariante, productKey } = require("./productKey.js");

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

  // Jetons décisifs : les nombres (modèle, génération, capacité) ET les
  // suffixes de gamme (Ti, Pro, Ultra…). Ces derniers manquaient : ils ne
  // portent pas de chiffre, donc rien n'empêchait de confondre une RTX 4060
  // avec une RTX 4060 Ti. Comme sameProduct applique cette fonction dans les
  // deux sens, exiger les jetons décisifs de la requête suffit à rendre la
  // séparation symétrique.
  const decisiveWords = queryWords.filter((w) => /\d/.test(w) || estMarqueurVariante(w));
  const textWords = queryWords.filter((w) => !/\d/.test(w) && !estMarqueurVariante(w));

  const allDecisivePresent = decisiveWords.every((w) => titleWords.has(w));
  if (!allDecisivePresent) return false;

  if (textWords.length === 0) return true;
  const matches = textWords.filter((w) => titleWords.has(w)).length;
  return matches >= Math.ceil(textWords.length / 2);
}

/**
 * Retire du lot les accessoires, les annonces reconditionnées/d'occasion et
 * les produits qui ne correspondent manifestement pas à la recherche, avant
 * toute analyse de prix.
 */
function filterRelevantOffers(offers, query, { inclureReconditionne = false } = {}) {
  return offers.filter(
    (o) =>
      !isAccessoryTitle(o.name) &&
      (inclureReconditionne || !estReconditionne(o)) &&
      titleMatchesQuery(o.name, query) &&
      // Liste noire tenue à la main : elle rattrape ce que les règles
      // automatiques laissent passer — une gamme d'accessoires dont le nom
      // ressemble trop au produit, un marchand systématiquement trompeur.
      !offreBannie(o)
  );
}

/**
 * Sépare un lot en offres neuves et offres reconditionnées.
 *
 * Le reconditionné était purement et simplement jeté. Maintenant qu'il
 * dispose de sa propre section, l'écarter du calcul de la référence du neuf
 * reste indispensable — mais le perdre serait dommage : c'est un marché à
 * part entière, avec ses propres bonnes affaires, qu'il suffit de comparer
 * à lui-même.
 */
function separerOffres(offers, query) {
  const pertinentes = filterRelevantOffers(offers, query, { inclureReconditionne: true });
  return {
    neuf: pertinentes.filter((o) => !estReconditionne(o)),
    reconditionne: pertinentes.filter((o) => estReconditionne(o)),
  };
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

/**
 * Écart absolu médian, remis à l'échelle d'un écart-type.
 *
 * C'est le remplaçant robuste de l'écart-type pour juger si un prix sort de
 * la distribution. Un seuil en pourcentage fixe — −60 % vaut « erreur » —
 * ignore la dispersion réelle : sur des petits prix, cet écart survient
 * constamment ; sur du gros électroménager, jamais. Rapporté au MAD, le même
 * seuil s'adapte de lui-même à chaque produit, sans réglage par catégorie.
 *
 * Le facteur 1,4826 est la constante qui rend le MAD comparable à un
 * écart-type sur une distribution normale.
 */
function madNormalise(nums) {
  if (!nums || nums.length < 3) return 0;
  const med = median(nums);
  const ecarts = nums.map((n) => Math.abs(n - med));
  return median(ecarts) * 1.4826;
}

/**
 * Combine deux références en les pondérant par leur fiabilité respective.
 *
 * Remplace `histRef || peerRef`, qui faisait toujours gagner l'historique dès
 * qu'il existait — donc systématiquement le signal le moins sûr. Quand une
 * seule des deux références est disponible, elle est renvoyée telle quelle.
 */
function combinerReferences(a, b) {
  const valides = [a, b].filter((r) => r && Number.isFinite(r.valeur) && r.valeur > 0 && r.poids > 0);
  if (valides.length === 0) return null;
  if (valides.length === 1) return valides[0].valeur;
  const total = valides.reduce((s, r) => s + r.poids, 0);
  return valides.reduce((s, r) => s + r.valeur * r.poids, 0) / total;
}

/**
 * L'offre porte-t-elle un état autre que neuf ?
 *
 * Deux sources d'information, et il faut les deux : le champ structuré de la
 * source quand il existe, et le titre en repli. Ne regarder que le titre —
 * ce que faisait le code — laissait passer toutes les annonces
 * reconditionnées dont le titre ne le mentionne pas, c'est-à-dire la plupart
 * de celles des plateformes spécialisées.
 */
function estReconditionne(offre) {
  if (offre.itemCondition && offre.itemCondition !== "neuf") return true;
  return isUsedOrRefurbishedTitle(offre.name);
}

/** Clé produit d'un titre — réexportée depuis productKey pour lisibilité locale. */
function cleProduit(nom) {
  return productKey(nom);
}

const BIG_SELLERS = ["amazon", "cdiscount", "fnac", "ldlc", "darty", "boulanger", "materiel.net", "rakuten", "leclerc", "carrefour"];

// Une place de marché n'est pas l'enseigne qui l'héberge. « Cdiscount
// Marketplace » contient « cdiscount », donc le test d'inclusion brut le
// classait vendeur de confiance et lui accordait +15 au score et +10 à la
// confiance — alors qu'un vendeur tiers est précisément le cas le moins
// fiable. Le fichier test-algorithm.js du dépôt utilise lui-même
// « Cdiscount Marketplace » comme exemple d'offre douteuse.
const MARKETPLACE_MARKERS = ["marketplace", "market place", "vendu par", "vendeur "];

function isMarketplaceSeller(seller) {
  const s = (seller || "").toLowerCase();
  return MARKETPLACE_MARKERS.some((m) => s.includes(m));
}

/** Enseigne connue vendant en son nom propre — pas un vendeur tiers hébergé. */
function isTrustedSeller(seller) {
  if (isMarketplaceSeller(seller)) return false;
  const s = (seller || "").toLowerCase();
  return BIG_SELLERS.some((b) => s.includes(b));
}

/**
 * Prix réellement payé, frais de port compris.
 *
 * Une offre à 200 € plus 40 € de port n'est pas une affaire face à 220 €
 * livrés — et c'est le vecteur classique des places de marché trompeuses :
 * afficher un prix bas et se rattraper sur la livraison. Le champ existait
 * dans les réponses de la source mais n'était pas lu, ce qui produisait
 * mécaniquement de faux positifs.
 */
function prixTotal(offre) {
  const port = Number.isFinite(offre.delivery) ? offre.delivery : 0;
  return offre.price + port;
}

/**
 * Référence historique d'un produit, robuste au temps ET aux marchands.
 *
 * L'ancienne version prenait la moyenne des 200 derniers prix enregistrés,
 * tous marchands et toutes dates confondus. Quatre défauts se superposaient :
 * une moyenne se déplace avec un seul intrus ; mélanger marchands et dates
 * dans un seul nombre perd les deux dimensions ; un prix d'il y a trois mois
 * pesait autant qu'un prix d'hier, ce qui rend la référence structurellement
 * trop haute sur du matériel qui se déprécie et fabrique de faux « deals » en
 * continu ; et 200 lignes ne représentent qu'une vingtaine d'heures sur un
 * produit actif.
 *
 * On procède donc en deux temps : une médiane pondérée par la récence pour
 * chaque marchand, puis la médiane de ces médianes. Un marchand qui publie
 * beaucoup d'offres ne pèse ainsi pas plus qu'un autre.
 *
 * @param {Array} rows - [{price, seller, scraped_at}, …]
 * @param {Date} [maintenant]
 * @param {number} [demiVieJours] - au bout de combien de jours un prix pèse moitié moins
 */
function referenceHistorique(rows, maintenant = new Date(), demiVieJours = 14) {
  if (!rows || rows.length === 0) return null;

  const parMarchand = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.price) || r.price <= 0) continue;
    const cle = (r.seller || "inconnu").toLowerCase();
    if (!parMarchand.has(cle)) parMarchand.set(cle, []);
    const ageJours = Math.max(0, (maintenant - parseDateSql(r.scraped_at)) / 86400000);
    parMarchand.get(cle).push({ prix: r.price, poids: Math.pow(0.5, ageJours / demiVieJours) });
  }
  if (parMarchand.size === 0) return null;

  const medianesMarchands = [];
  for (const points of parMarchand.values()) {
    const m = medianePonderee(points);
    if (m != null) medianesMarchands.push(m);
  }
  return medianesMarchands.length > 0 ? median(medianesMarchands) : null;
}

/** Médiane pondérée : la valeur où la moitié du poids total est atteinte. */
function medianePonderee(points) {
  const tries = [...points].sort((a, b) => a.prix - b.prix);
  const total = tries.reduce((s, p) => s + p.poids, 0);
  if (total <= 0) return null;
  let cumul = 0;
  for (const p of tries) {
    cumul += p.poids;
    if (cumul >= total / 2) return p.prix;
  }
  return tries[tries.length - 1].prix;
}

/** Date SQLite ("YYYY-MM-DD HH:MM:SS", UTC) en objet Date. */
function parseDateSql(s) {
  if (!s) return new Date(0);
  const d = new Date(String(s).replace(" ", "T") + (String(s).endsWith("Z") ? "" : "Z"));
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

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
  // Le prix comparé est toujours le prix livré : sans les frais de port, on
  // compare ce qui est affiché plutôt que ce qui est payé.
  const peerRefByOffer = new Map();
  const peerStatsByOffer = new Map();
  for (const cluster of clusterByProduct(offers)) {
    // Les offres reconditionnées ne servent jamais à établir la référence du
    // neuf : elles sont légitimement moins chères, et les inclure abaisserait
    // la médiane au point de masquer les vraies anomalies.
    const comparables = cluster.filter((o) => !estReconditionne(o));
    if (comparables.length < R.minPairs) continue;
    const prices = stripGrossOutliers(comparables.map(prixTotal));
    const ref = trimmedMedian(prices);
    const stats = {
      size: prices.length,
      cv: coefficientOfVariation(prices),
      mad: madNormalise(prices),
    };
    for (const o of cluster) {
      peerRefByOffer.set(o, ref);
      peerStatsByOffer.set(o, stats);
    }
  }

  // Un seul aller-retour en base pour tout le lot, au lieu d'un par offre.
  const historiques = priceHistoryBatch(offers.map((o) => o.name));
  const maintenant = new Date();

  return offers.map((o) => {
    const total = prixTotal(o);
    const lignes = (historiques.get(cleProduit(o.name)) || []).filter((r) => r.price !== o.price);

    // Référence historique robuste : médiane pondérée par la récence, par
    // marchand, puis médiane de ces médianes. Voir referenceHistorique.
    const marchandsVus = new Set(lignes.map((r) => (r.seller || "inconnu").toLowerCase()));
    const histRef =
      lignes.length >= R.minHistorique ? referenceHistorique(lignes, maintenant) : null;

    // "Prix le plus bas jamais vu" : vrai seulement s'il y a un historique
    // pour comparer (sinon toute première observation serait trivialement "la plus basse").
    const allTimeLow =
      lignes.length >= R.minHistorique && total < Math.min(...lignes.map((r) => r.price));

    const peerStats = peerStatsByOffer.get(o) || null;
    const peerRef = peerRefByOffer.get(o) || null;

    // Combinaison pondérée plutôt que `histRef || peerRef`.
    // L'ancienne écriture faisait toujours gagner l'historique dès qu'il
    // existait — c'est-à-dire le signal le moins fiable des deux, puisqu'il
    // agrégeait des marchands et des dates sans distinction. On pondère
    // désormais chaque référence par ce qui la rend digne de confiance : le
    // nombre de marchands distincts pour l'historique, le nombre de pairs
    // comparables pour la médiane du jour.
    const refPrice = combinerReferences(
      { valeur: histRef, poids: Math.min(marchandsVus.size, 5) },
      { valeur: peerRef, poids: Math.min(peerStats?.size || 0, 5) }
    );
    if (!refPrice) {
      return { ...o, priceTotal: total, refPrice: null, pct: 0, verdict: "normal", score: 0, confidence: null, allTimeLow: false };
    }
    const pct = Math.round((1 - total / refPrice) * 100);

    let verdict = "normal";
    if (pct >= R.seuilErreur) verdict = "erreur";
    else if (pct >= R.seuilDeal) verdict = "deal";

    const vendeurSur = isTrustedSeller(o.seller);

    // Deal Score : uniquement l'attractivité du prix.
    let score = Math.min(Math.max(pct, 0), 70);
    if (verdict === "erreur") score += 15;
    if (vendeurSur) score += 15;
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
    if (vendeurSur) confidence += 10;
    // Une place de marché tierce mérite l'inverse d'un bonus : c'est là que
    // se concentrent les annonces trompeuses.
    if (isMarketplaceSeller(o.seller)) confidence -= 15;
    confidence = Math.max(0, Math.min(100, Math.round(confidence)));

    // Plancher de confiance : au-delà d'un certain doute, mieux vaut ne rien
    // annoncer qu'annoncer une anomalie qui n'en est pas une. À 0 (valeur
    // d'origine), ce filtre ne retire rien.
    if (verdict !== "normal" && confidence < R.confianceMin) verdict = "normal";

    return {
      ...o,
      priceTotal: total,
      refPrice: Math.round(refPrice),
      pct,
      verdict,
      score,
      confidence,
      allTimeLow,
      // Écart exprimé en unités de dispersion du produit lui-même. Contrairement
      // au pourcentage, il est comparable d'une catégorie à l'autre : −22 % sur
      // un marché où tout le monde est à ±1 % est bien plus anormal que −60 %
      // sur un marché où les prix vont du simple au triple. Sert de socle au
      // détecteur d'erreur de prix (voir anomalies.js).
      zScore: peerStats?.mad > 0 ? Number(((refPrice - total) / peerStats.mad).toFixed(2)) : null,
    };
  });
}

module.exports = {
  analyzeOffers,
  filterRelevantOffers,
  separerOffres,
  median,
  mean,
  trimmedMedian,
  stripGrossOutliers,
  coefficientOfVariation,
  madNormalise,
  isAccessoryTitle,
  isUsedOrRefurbishedTitle,
  estReconditionne,
  titleMatchesQuery,
  sameProduct,
  clusterByProduct,
  isTrustedSeller,
  isMarketplaceSeller,
  prixTotal,
  referenceHistorique,
  medianePonderee,
  combinerReferences,
};
