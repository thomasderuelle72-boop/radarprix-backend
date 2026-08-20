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
const { logSourceEvent } = require("./db");

async function fetchWithFallback(query, label) {
  // Chaque appel est consigné : c'est ce qui permet au tableau de bord de
  // dire "SerpApi en panne depuis 14 h" sans aller lire les journaux de
  // l'hébergeur, où ces pannes ne se voyaient qu'à la main.
  try {
    const offers = await fetchShoppingResults(query);
    logSourceEvent("serpapi", true, `${offers.length} offre(s) — ${query}`);
    return offers;
  } catch (e) {
    console.error(`[fetchOffers] SerpApi a échoué pour "${query}" (${label}) : ${e.message}`);
    logSourceEvent("serpapi", false, e.message);
    if (!process.env.BRIGHT_DATA_BROWSER_HOST) throw e;
    console.error(`[fetchOffers] repli sur Bright Data Browser API pour "${query}"`);
    try {
      const offers = await fetchShoppingResultsBrightData(query);
      logSourceEvent("brightdata", true, `${offers.length} offre(s) — ${query}`);
      return offers;
    } catch (e2) {
      logSourceEvent("brightdata", false, e2.message);
      throw e2;
    }
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
