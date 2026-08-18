// productKey.js — Primitives de normalisation de titres, partagées entre
// algorithm.js (pertinence/regroupement) et db.js (identité produit pour
// l'historique). Module autonome, sans dépendance vers db.js ou
// algorithm.js, pour éviter tout require() circulaire entre eux.

// Les mots vides ne comptent pas comme "mots significatifs" d'un titre.
const STOPWORDS = new Set(["de", "du", "des", "le", "la", "les", "un", "une", "et", "pour", "avec"]);

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
      return w.length >= 3 && !STOPWORDS.has(w);
    });
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

module.exports = { STOPWORDS, normalizeAbbreviations, significantWords, productKey };
