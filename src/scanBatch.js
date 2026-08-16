// scanBatch.js — Scanne un lot de produits du catalogue et les enregistre.
// Utilisé à la fois par cron.js (planifié) et par la route admin
// "lancer un scan maintenant" (à la demande), pour ne pas dupliquer la logique.
const { fetchShoppingResults } = require("./serpapi");
const { insertSnapshots } = require("./db");
const { allProducts } = require("./catalog");

const PRODUCTS = allProducts();
let cursor = 0;

/**
 * Scanne `size` produits du catalogue (rotation continue à chaque appel)
 * et les enregistre en base. Renvoie un résumé pour affichage/logs.
 */
async function runCatalogBatch(size = 10) {
  const batch = [];
  for (let i = 0; i < size; i++) {
    batch.push(PRODUCTS[cursor % PRODUCTS.length]);
    cursor++;
  }

  const results = [];
  for (const { name, category } of batch) {
    try {
      const offers = await fetchShoppingResults(name);
      insertSnapshots(name.toLowerCase(), category, offers);
      results.push({ name, category, offersFound: offers.length, ok: true });
    } catch (e) {
      results.push({ name, category, error: e.message, ok: false });
    }
    await new Promise((r) => setTimeout(r, 1500)); // pause entre deux requêtes
  }
  return results;
}

module.exports = { runCatalogBatch, PRODUCTS };
