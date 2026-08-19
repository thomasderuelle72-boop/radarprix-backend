// fetchOffers.js — Point d'entrée unique pour récupérer des offres : SerpApi
// d'abord (quota mensuel, gratuit), repli sur Bright Data Browser API si
// SerpApi échoue (quota épuisé, panne). Même ordre pour la recherche en
// direct et pour le scan catalogue planifié : contrairement aux deux
// premiers essais Bright Data (Web Unlocker, SERP API — gratuits, mais qui
// ne rendaient pas le JS), le Browser API fonctionne réellement mais coûte
// au volume de données ($8/Go) — jamais la source par défaut pour du trafic
// récurrent, seulement un filet de sécurité.
const { fetchShoppingResults } = require("./serpapi");
const { fetchShoppingResultsBrightData } = require("./brightdata");

async function fetchWithFallback(query, label) {
  try {
    return await fetchShoppingResults(query);
  } catch (e) {
    console.error(`[fetchOffers] SerpApi a échoué pour "${query}" (${label}) : ${e.message}`);
    if (!process.env.BRIGHT_DATA_BROWSER_HOST) throw e;
    console.error(`[fetchOffers] repli sur Bright Data Browser API pour "${query}"`);
    return fetchShoppingResultsBrightData(query);
  }
}

/** Recherche en direct (à la demande). */
function fetchLiveOffers(query) {
  return fetchWithFallback(query, "recherche en direct");
}

/** Scan catalogue planifié. */
function fetchCatalogOffers(query) {
  return fetchWithFallback(query, "scan catalogue");
}

module.exports = { fetchLiveOffers, fetchCatalogOffers };
