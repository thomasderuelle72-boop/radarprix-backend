// cron.js — Scanne le catalogue en tâche de fond pour construire le pool
// de "deals du moment" que le site sert ensuite instantanément (voir
// /api/deals dans server.js). C'est CE script qui consomme le quota
// SerpApi, pas les visiteurs du site — leur navigation reste gratuite
// et illimitée puisqu'ils ne font que lire ce qui est déjà en base.
//
// ⚠️ Sur le plan gratuit SerpApi (~100 requêtes/mois), scanner tout le
// catalogue (plusieurs dizaines de produits) plusieurs fois par jour
// n'est pas tenable. Ajuste CRON_SCHEDULE et BATCH_SIZE ci-dessous selon
// ton quota réel, ou passe à un plan payant si tu veux des données plus
// fraîches. À lancer en tâche de fond continue (`npm run cron`).
require("dotenv").config();
const cron = require("node-cron");
const { fetchShoppingResults } = require("./serpapi");
const { insertSnapshots } = require("./db");
const { allProducts } = require("./catalog");

// Nombre de produits scannés à chaque exécution du cron (pas tout le
// catalogue d'un coup, pour rester raisonnable sur le quota gratuit).
const BATCH_SIZE = parseInt(process.env.CRON_BATCH_SIZE || "10", 10);
// Fréquence : toutes les 2 heures par défaut. Un produit scanné une fois
// toutes les 2h avec un batch de 10 sur ~50 produits ≈ tout le catalogue
// couvert en une dizaine d'exécutions, soit environ une journée.
const SCHEDULE = process.env.CRON_SCHEDULE || "0 */2 * * *";

const PRODUCTS = allProducts(); // [{name, category}, ...]
let cursor = 0;

async function runBatch() {
  const batch = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    batch.push(PRODUCTS[cursor % PRODUCTS.length]);
    cursor++;
  }

  for (const { name, category } of batch) {
    try {
      const offers = await fetchShoppingResults(name);
      insertSnapshots(name.toLowerCase(), category, offers);
      console.log(`[${new Date().toISOString()}] ${name} (${category}) : ${offers.length} offres`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Échec sur "${name}" :`, e.message);
    }
    await new Promise((r) => setTimeout(r, 1500)); // pause entre deux requêtes
  }
}

cron.schedule(SCHEDULE, runBatch);
console.log(`Cron RadarPrix démarré — ${BATCH_SIZE} produits toutes les exécutions (${SCHEDULE}).`);
console.log(`Catalogue total : ${PRODUCTS.length} produits.`);
runBatch(); // premier lot immédiat au démarrage
