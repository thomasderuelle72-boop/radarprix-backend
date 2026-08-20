// sources/index.js — Orchestration de la collecte.
//
// Chaque source sait produire des deals normalisés ; ce module les fait
// tourner, les score, décide de leur publication et les écrit. La logique
// commune vit ici plutôt que dupliquée dans chaque client : ajouter GOG ou
// Prime Gaming ne demande alors qu'une entrée dans le registre.
//
// Règle de robustesse : l'échec d'une source n'interrompt jamais les autres.
// Un flux en panne ne doit pas priver le site de tout son contenu.
const { fetchEpicFreeGames } = require("./epic");
const { fetchStrackrDeals, fetchAwinOffers } = require("./promos");
const { upsertDeal, markMissingAsRemoved } = require("../dealsStore");
const { scoreDesirabilite, meritePublication } = require("../curation");
const { logSourceEvent, db } = require("../db");

/**
 * Registre des sources.
 *
 * `actif` détermine si la source a de quoi fonctionner : une source sans clé
 * d'API se désactive d'elle-même, silencieusement. C'est le même parti pris
 * que pour Resend dans email.js — en local ou sur un déploiement minimal, on
 * veut que tout démarre sans exiger la totalité des identifiants.
 */
const SOURCES = [
  {
    nom: "epic",
    detecteur: "D2",
    libelle: "Epic Games Store — jeux offerts",
    actif: () => true, // endpoint public, aucune clé nécessaire
    collecter: fetchEpicFreeGames,
  },
  {
    nom: "strackr",
    detecteur: "D1",
    libelle: "Strackr — promotions et codes promo agrégés",
    actif: () => Boolean(process.env.STRACKR_API_KEY),
    collecter: fetchStrackrDeals,
  },
  {
    nom: "awin",
    detecteur: "D1",
    libelle: "Awin — promotions et codes promo",
    actif: () => Boolean(process.env.AWIN_API_TOKEN),
    collecter: fetchAwinOffers,
  },
];

/**
 * Fiabilité d'un marchand, entre 0 et 1, telle que la communauté l'a jugée.
 * Renvoie null si le marchand est inconnu — le score de désirabilité traite
 * alors le marchand comme neutre plutôt que de lui inventer une réputation.
 */
function fiabiliteDe(marchand) {
  if (!marchand) return null;
  try {
    const row = db
      .prepare(
        `SELECT AVG(CASE WHEN v.value = 1 THEN 1.0 ELSE 0.0 END) AS taux, COUNT(*) AS n
         FROM community_deals d
         JOIN community_votes v ON v.deal_id = d.id
         WHERE lower(d.seller) = lower(?)`
      )
      .get(marchand);
    // En dessous de cinq votes, la moyenne est trop instable pour peser sur
    // un classement : on préfère ne rien affirmer.
    return row && row.n >= 5 ? row.taux : null;
  } catch {
    return null;
  }
}

/**
 * Fait tourner une source et enregistre ce qu'elle rapporte.
 * @returns {Promise<object>} résumé { nom, ok, collectes, publies, erreur }
 */
async function collecterSource(source) {
  if (!source.actif()) {
    return { nom: source.nom, ok: true, ignoree: true, collectes: 0, publies: 0 };
  }

  let deals;
  try {
    deals = await source.collecter();
  } catch (e) {
    // Consigné comme les scans SerpApi, pour que le tableau de bord de santé
    // montre les pannes de flux au même endroit que les pannes de scan.
    logSourceEvent(source.nom, false, e.message);
    console.error(`[sources] ${source.nom} a échoué : ${e.message}`);
    return { nom: source.nom, ok: false, collectes: 0, publies: 0, erreur: e.message };
  }

  let publies = 0;
  const vus = [];
  for (const deal of deals) {
    try {
      const score = scoreDesirabilite(deal, { fiabiliteMarchand: fiabiliteDe(deal.merchant) });
      const publier = meritePublication(deal, score);
      upsertDeal({
        ...deal,
        score,
        // On date la publication à l'insertion plutôt que d'appeler
        // publierDeal ensuite : une écriture au lieu de deux, et le deal
        // n'existe jamais dans un état intermédiaire visible.
        publishedAt: publier ? new Date().toISOString().slice(0, 19).replace("T", " ") : null,
      });
      vus.push(deal.externalId);
      if (publier) publies++;
    } catch (e) {
      // Un deal mal formé ne doit pas faire échouer tout le lot : on le
      // signale et on continue avec les suivants.
      console.error(`[sources] ${source.nom} — deal ignoré : ${e.message}`);
    }
  }

  // Les offres absentes du flux ont été retirées par le marchand.
  const retires = markMissingAsRemoved(source.nom, vus);

  logSourceEvent(source.nom, true, `${deals.length} offre(s), ${publies} publiée(s), ${retires} retirée(s)`);
  return { nom: source.nom, ok: true, collectes: deals.length, publies, retires };
}

/**
 * Fait tourner toutes les sources actives, ou celles d'un détecteur donné.
 * @param {object} [opts]
 * @param {string} [opts.detecteur] - "D1" ou "D2" pour ne collecter que celles-là
 */
async function collecterTout({ detecteur = null } = {}) {
  const aFaire = SOURCES.filter((s) => !detecteur || s.detecteur === detecteur);
  const resultats = [];
  for (const source of aFaire) {
    resultats.push(await collecterSource(source));
  }
  return resultats;
}

module.exports = { SOURCES, collecterSource, collecterTout, fiabiliteDe };
