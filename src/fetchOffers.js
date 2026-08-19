// fetchOffers.js — Point d'entrée unique pour récupérer des offres, avec
// repli automatique entre SerpApi et Bright Data selon le contexte d'appel.
// Deux usages distincts dans le projet, chacun avec sa source par défaut :
//   - recherche en direct (server.js, à la demande) : Bright Data en priorité,
//     pour épargner le quota SerpApi (~100 req/mois) sur du trafic imprévisible.
//   - scan catalogue planifié (scanBatch.js/cron.js) : SerpApi en priorité
//     (source historique, déjà éprouvée), Bright Data en repli si SerpApi
//     échoue (quota épuisé, panne, etc.) plutôt que de laisser le cron
//     échouer intégralement.
const { fetchShoppingResults } = require("./serpapi");
const { fetchShoppingResultsBrightData } = require("./brightdata");

/** Recherche en direct : Bright Data d'abord si configuré, repli sur SerpApi. */
async function fetchLiveOffers(query) {
  if (process.env.BRIGHT_DATA_API_KEY) {
    try {
      const offers = await fetchShoppingResultsBrightData(query);
      if (offers.length > 0) return offers;
    } catch (e) {
      console.error(`[fetchOffers] Bright Data a échoué pour "${query}", repli sur SerpApi : ${e.message}`);
    }
  }
  return fetchShoppingResults(query);
}

/** Scan catalogue : SerpApi d'abord, repli sur Bright Data si SerpApi échoue. */
async function fetchCatalogOffers(query) {
  try {
    return await fetchShoppingResults(query);
  } catch (e) {
    console.error(`[fetchOffers] SerpApi a échoué pour "${query}" (${e.message})`);
    if (!process.env.BRIGHT_DATA_API_KEY) throw e;
    console.error(`[fetchOffers] repli sur Bright Data pour "${query}"`);
    return fetchShoppingResultsBrightData(query);
  }
}

module.exports = { fetchLiveOffers, fetchCatalogOffers };
