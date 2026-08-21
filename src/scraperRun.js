// scraperRun.js — Le va-et-vient d'une collecte asynchrone.
//
// L'API d'extraction ne répond pas sur-le-champ : on déclenche, elle rend un
// identifiant, les données arrivent plus tard. Deux moments distincts donc,
// et c'est ce module qui les enchaîne :
//
//   1. récupérer les collectes précédentes devenues prêtes, et publier ;
//   2. déclencher un nouveau lot pour la suite.
//
// L'ordre compte. Récupérer d'abord évite d'empiler des collectes en attente
// quand la publication échoue : si quelque chose cloche en aval, on s'en
// aperçoit avant d'avoir déclenché dix lots de plus.
const {
  declencher, recupererCollecte, cloturerCollecte, collectesEnCours, normaliserProduit, extracteurs,
} = require("./sources/scraper");
const { upsertDeal } = require("./dealsStore");
const { scoreDesirabilite, meritePublication } = require("./curation");
const { fiabilite } = require("./reputation");
const { listerUrls } = require("./watch");
const { logSourceEvent } = require("./db");

/** Publie un produit rendu par un extracteur. */
function publier(produit) {
  // Une offre en rupture n'est pas une affaire : on ne la publie jamais,
  // même si son prix est attirant. C'est le premier motif de déception.
  if (produit.enRupture) return false;

  const deal = { ...produit };
  delete deal.enRupture;
  delete deal.gtin;

  const score = scoreDesirabilite(deal, { fiabiliteMarchand: fiabilite(deal.merchant) });
  upsertDeal({
    ...deal,
    score,
    payload: { ...produit.payload, gtin: produit.gtin || null },
    publishedAt: meritePublication(deal, score) ? new Date().toISOString().slice(0, 19).replace("T", " ") : null,
  });
  return true;
}

/** Récupère les collectes terminées et publie ce qu'elles rapportent. */
async function recupererLesPretes({ fetcher = fetch } = {}) {
  const resultats = [];

  for (const collecte of collectesEnCours()) {
    try {
      const { prete, produits } = await recupererCollecte(collecte.snapshot_id, { fetcher });
      if (!prete) {
        resultats.push({ snapshot: collecte.snapshot_id, enCours: true });
        continue;
      }

      let publies = 0;
      for (const brut of produits) {
        const produit = normaliserProduit(brut, {
          marchand: collecte.marchand,
          categorie: collecte.categorie,
        });
        if (produit && publier(produit)) publies++;
      }

      cloturerCollecte(collecte.snapshot_id, { produits: publies });
      logSourceEvent("brightdata-scraper", true, `${collecte.marchand} : ${publies} produit(s) publié(s)`);
      resultats.push({ snapshot: collecte.snapshot_id, marchand: collecte.marchand, publies });
    } catch (e) {
      cloturerCollecte(collecte.snapshot_id, { erreur: e.message });
      logSourceEvent("brightdata-scraper", false, `${collecte.marchand} : ${e.message}`);
      resultats.push({ snapshot: collecte.snapshot_id, marchand: collecte.marchand, erreur: e.message });
    }
  }

  return resultats;
}

/**
 * Déclenche une collecte par extracteur configuré, sur des fiches déjà
 * surveillées du marchand correspondant.
 *
 * On réutilise la liste de surveillance plutôt que de redécouvrir des
 * adresses : ce sont les fiches dont le site suit déjà le prix, donc celles
 * pour lesquelles une seconde lecture structurée a le plus de valeur.
 */
async function declencherLesLots({ parLot = 20, fetcher = fetch } = {}) {
  const config = extracteurs();
  if (config.length === 0) return [];

  const resultats = [];
  const surveillees = listerUrls({ limit: 10000 });

  for (const { marchand, datasetId, categorie } of config) {
    const urls = surveillees
      .filter((u) => (u.merchant || "").toLowerCase().includes(marchand.toLowerCase()))
      .slice(0, parLot)
      .map((u) => u.url);

    if (urls.length === 0) {
      resultats.push({ marchand, ignore: true, motif: "aucune fiche surveillée pour ce marchand" });
      continue;
    }

    try {
      const snapshotId = await declencher({ datasetId, urls, marchand, categorie, fetcher });
      resultats.push({ marchand, snapshot: snapshotId, urls: urls.length });
    } catch (e) {
      resultats.push({ marchand, erreur: e.message });
    }
  }

  return resultats;
}

/** Un passage complet : on récupère, puis on redéclenche. */
async function tourComplet(opts = {}) {
  const recuperees = await recupererLesPretes(opts);
  const declenchees = await declencherLesLots(opts);
  return { recuperees, declenchees };
}

module.exports = { tourComplet, recupererLesPretes, declencherLesLots, publier };
