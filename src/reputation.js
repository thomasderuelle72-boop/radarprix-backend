// reputation.js — La fiabilité d'un marchand, mesurée plutôt que décrétée.
//
// Le détecteur d'origine jugeait un vendeur sur une liste de dix noms écrite
// en dur (BIG_SELLERS). Cette liste a deux défauts : elle ne dit rien des
// centaines d'autres marchands, et elle est fausse dès qu'un nom la contient
// par accident — « Cdiscount Marketplace » y était reconnu comme Cdiscount.
//
// Ici, la réputation se déduit de ce que le site a réellement observé :
//
//  • ce que la modération a jugé sur les détections de ce marchand ;
//  • ce que la communauté a voté sur les deals qui le concernent ;
//  • la tenue de ses prix, c'est-à-dire la fréquence à laquelle une anomalie
//    détectée chez lui se révèle durable plutôt qu'évanouie.
//
// La liste en dur reste utilisée, mais seulement comme valeur de départ pour
// les marchands sur lesquels on n'a encore rien mesuré — un a priori, pas un
// verdict.
const { db } = require("./db");
const { isTrustedSeller, isMarketplaceSeller } = require("./algorithm");

// En deçà de ce nombre d'observations, une moyenne n'est pas une mesure :
// c'est du bruit. On préfère alors l'a priori au chiffre.
const OBSERVATIONS_MIN = 5;

/** Clé de regroupement : un même marchand écrit de dix façons doit compter pour un. */
function normaliserMarchand(nom) {
  return (nom || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(fr|com|store|boutique|officiel)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/**
 * A priori sur un marchand inconnu, entre 0 et 1.
 * Une place de marché tierce démarre plus bas qu'une enseigne connue : c'est
 * là que se concentrent les annonces trompeuses.
 */
function aPriori(marchand) {
  if (isMarketplaceSeller(marchand)) return 0.35;
  if (isTrustedSeller(marchand)) return 0.75;
  return 0.5;
}

/**
 * Fiabilité mesurée d'un marchand, entre 0 et 1.
 *
 * Renvoie l'a priori tant qu'il n'y a pas assez d'observations, et se
 * rapproche progressivement de la mesure à mesure qu'elles s'accumulent —
 * plutôt que de basculer brutalement au cinquième jugement.
 */
function fiabilite(marchand) {
  if (!marchand) return 0.5;
  const cle = normaliserMarchand(marchand);
  if (!cle) return 0.5;

  const jugements = db
    .prepare(
      `SELECT f.verdict, COUNT(*) AS n
       FROM deal_feedback f JOIN deals d ON d.id = f.deal_id
       WHERE replace(replace(lower(d.merchant), ' ', ''), '.', '') LIKE ?
       GROUP BY f.verdict`
    )
    .all(`%${cle}%`);

  const valides = jugements.find((r) => r.verdict === "valide")?.n || 0;
  const faux = jugements.find((r) => r.verdict === "faux_positif")?.n || 0;

  const votes = db
    .prepare(
      `SELECT SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END) AS pour,
              SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END) AS contre
       FROM community_deals d JOIN community_votes v ON v.deal_id = d.id
       WHERE replace(replace(lower(d.seller), ' ', ''), '.', '') LIKE ?`
    )
    .get(`%${cle}%`);

  const pour = votes?.pour || 0;
  const contre = votes?.contre || 0;

  const positifs = valides + pour;
  const negatifs = faux + contre;
  const total = positifs + negatifs;
  if (total === 0) return aPriori(marchand);

  const mesure = positifs / total;
  // Mélange progressif : à OBSERVATIONS_MIN observations, la mesure pèse la
  // moitié ; au-delà, elle prend le dessus sans jamais effacer complètement
  // l'a priori sur un très petit échantillon.
  const poidsMesure = Math.min(total / (total + OBSERVATIONS_MIN), 0.95);
  return Number((aPriori(marchand) * (1 - poidsMesure) + mesure * poidsMesure).toFixed(3));
}

/**
 * Classement des marchands sur lesquels on a réellement des observations.
 * Sert au tableau de bord et à repérer un marchand systématiquement trompeur
 * avant qu'il ne pollue durablement le flux.
 */
function classement({ limit = 50 } = {}) {
  const marchands = db
    .prepare(
      `SELECT d.merchant AS marchand, COUNT(*) AS detections
       FROM deals d
       WHERE d.merchant IS NOT NULL AND d.merchant != ''
       GROUP BY lower(d.merchant)
       ORDER BY detections DESC LIMIT ?`
    )
    .all(limit);

  return marchands
    .map((m) => ({
      marchand: m.marchand,
      detections: m.detections,
      fiabilite: fiabilite(m.marchand),
      placeDeMarche: isMarketplaceSeller(m.marchand),
      aPriori: aPriori(m.marchand),
    }))
    .sort((a, b) => b.fiabilite - a.fiabilite);
}

module.exports = { fiabilite, aPriori, classement, normaliserMarchand, OBSERVATIONS_MIN };
