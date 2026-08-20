// productKey.js — Primitives de normalisation de titres, partagées entre
// algorithm.js (pertinence/regroupement) et db.js (identité produit pour
// l'historique). Module autonome, sans dépendance vers db.js ou
// algorithm.js, pour éviter tout require() circulaire entre eux.

// Les mots vides ne comptent pas comme "mots significatifs" d'un titre.
const STOPWORDS = new Set(["de", "du", "des", "le", "la", "les", "un", "une", "et", "pour", "avec"]);

/**
 * Suffixes de gamme : ce qui sépare deux variantes d'un même modèle.
 *
 * Sans eux, une RTX 4060 et une RTX 4060 Ti étaient considérées comme le
 * même produit — "ti" ne porte aucun chiffre, et fait deux lettres, donc il
 * était doublement écarté : par le filtre de longueur ci-dessous, puis par
 * une comparaison qui ne jugeait décisifs que les jetons numériques. La
 * médiane du groupe se retrouvait tirée vers le haut par les variantes
 * chères, et le modèle de base ressortait comme un « deal » à −30 % qui
 * n'existait pas. Le même défaut confondait l'iPhone 15 et l'iPhone 15 Pro,
 * le Galaxy S24 et le S24 Ultra, la PS5 Slim et la PS5 Slim Digital.
 *
 * Ces jetons sont donc traités exactement comme des nombres : conservés même
 * très courts, et exigés des deux côtés pour qu'un rapprochement soit permis.
 */
const VARIANT_MARKERS = new Set([
  // Gammes constructeur
  "pro", "max", "plus", "ultra", "lite", "mini", "air", "se", "ti", "xt", "xtx",
  "super", "oled", "slim", "digital", "edition", "premium", "advanced", "elite",
  // Connectivité et finitions qui changent la référence et le prix
  "5g", "4g", "wifi", "cellular", "nfc",
  // Déclinaisons de taille de marché
  "femme", "homme", "enfant", "junior", "kid", "kids", "women", "men",
]);

// Normalisations AVANT découpage en mots :
//  - abréviations courantes ("PS5" vendeur vs "PlayStation 5" catalogue) ;
//  - suffixes ordinaux français/anglais collés à un nombre ("10e génération",
//    "2ème génération", "2nd Gen") ramenés au nombre nu, pour que "iPad 10e
//    génération" et "iPad 10th Gen" (ou "iPad Gen 10") partagent le même
//    identifiant malgré des formulations différentes selon le vendeur.
function normalizeAbbreviations(text) {
  return (text || "")
    .replace(/\bps\s*([1-5])\b/gi, "playstation $1")
    .replace(/\bxbox\s*one\b/gi, "xbox one")
    .replace(/\b(\d+)\s*(?:e|ème|eme|nd|nde|er|ère|ere|th|st|rd)\b/gi, "$1");
}

function significantWords(text) {
  const normalized = normalizeAbbreviations(text)
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, ""); // enlève les accents
  return normalized
    .split(/[^a-z0-9]+/)
    .filter((w) => {
      if (!w) return false;
      // Un token contenant un chiffre (15, 128, 4060, s24...) est presque
      // toujours un identifiant de modèle/génération/capacité : on le garde
      // TOUJOURS, même court — c'est justement ce qui distingue un iPhone 15
      // d'un iPhone 11, ou une RTX 4060 d'une RTX 4070.
      if (/\d/.test(w)) return true;
      // "ti", "se", "xt" font deux lettres : sans cette exception, le filtre
      // de longueur les supprimait, et avec eux toute possibilité de
      // distinguer une RTX 4060 Ti d'une RTX 4060.
      if (VARIANT_MARKERS.has(w)) return true;
      return w.length >= 3 && !STOPWORDS.has(w);
    });
}

/** Un jeton distingue-t-il deux variantes d'un même modèle ? */
function estMarqueurVariante(mot) {
  return VARIANT_MARKERS.has(mot);
}

/**
 * Identifiant stable d'un produit à partir de son titre : le même produit
 * décrit différemment par deux vendeurs ("Apple AirPods Pro 2 USB-C" vs
 * "AirPods Pro 2e génération USB-C Apple") doit produire la même clé, pour
 * que l'historique de prix se construise sur le produit, pas sur le texte
 * exact du titre. Mots significatifs triés (insensibles à l'ordre des mots
 * entre vendeurs) puis joints — volontairement strict (ensemble de mots
 * identique) : mieux vaut un historique qui démarre à zéro pour un titre
 * inhabituel qu'un faux rapprochement entre deux produits différents.
 */
function productKey(name) {
  return significantWords(name).sort().join(" ");
}

module.exports = {
  STOPWORDS,
  VARIANT_MARKERS,
  estMarqueurVariante,
  normalizeAbbreviations,
  significantWords,
  productKey,
};
