// scanBatch.js — Scanne un lot de produits du catalogue et les enregistre.
// Utilisé à la fois par cron.js (planifié) et par la route admin
// "lancer un scan maintenant" (à la demande), pour ne pas dupliquer la logique.
const { fetchCatalogOffers } = require("./fetchOffers");
const { filterRelevantOffers, analyzeOffers } = require("./algorithm");
const { insertSnapshots, watchersFor, recordAlertSent } = require("./db");
const { allProducts } = require("./catalog");
const { sendPriceErrorAlert } = require("./email");

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
      const rawOffers = await fetchCatalogOffers(name);
      // Même filtrage qu'en recherche directe (scanQuery dans server.js) : on
      // écarte accessoires et hors-sujet AVANT insertion, sinon l'historique
      // automatique du cron se fait polluer par de mauvaises offres que la
      // recherche directe, elle, filtre déjà.
      const offers = filterRelevantOffers(rawOffers, name);
      insertSnapshots(name.toLowerCase(), category, offers);
      try {
        await notifyWatchers(name, offers);
      } catch (e) {
        // Un échec d'envoi d'alerte ne doit jamais faire échouer le scan lui-même.
        console.error(`[scanBatch] notifyWatchers a échoué pour "${name}": ${e.message}`);
      }
      results.push({ name, category, offersFound: offers.length, ok: true });
    } catch (e) {
      results.push({ name, category, error: e.message, ok: false });
    }
    await new Promise((r) => setTimeout(r, 1500)); // pause entre deux requêtes
  }
  return results;
}

/**
 * Prévient par email les membres qui suivent ce produit (favoris) quand une
 * erreur de prix vient d'être détectée, avec dédoublonnage : une alerte
 * n'est ré-envoyée que si le prix erroné a changé depuis la dernière fois
 * (voir recordAlertSent / UNIQUE(user_id, query, price)).
 */
async function notifyWatchers(name, offers) {
  const watchers = watchersFor(name);
  if (watchers.length === 0) return;

  const analyzed = analyzeOffers(offers);
  const best = analyzed.find((o) => o.verdict === "erreur");
  if (!best) return;

  for (const { user_id, email } of watchers) {
    if (!recordAlertSent(user_id, name, best.price)) continue; // déjà notifié pour ce prix
    await sendPriceErrorAlert(email, {
      name,
      price: best.price,
      refPrice: best.refPrice,
      pct: best.pct,
      url: best.url,
    });
  }
}

module.exports = { runCatalogBatch, PRODUCTS, notifyWatchers };
