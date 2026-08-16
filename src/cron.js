// cron.js — Lance des scans automatiques à intervalle régulier, pour que
// l'historique de prix se construise même sans visiteur sur le site.
// À lancer en tâche de fond continue (ex: `npm run cron` sur Railway/Render).
require("dotenv").config();
const cron = require("node-cron");
const { fetchShoppingResults } = require("./serpapi");
const { insertSnapshots } = require("./db");

const QUERIES = [
  { q: "carte graphique promo", category: "hightech" },
  { q: "smartphone promo", category: "hightech" },
  { q: "PC portable gamer promo", category: "gaming" },
  { q: "casque audio promo", category: "hightech" },
  { q: "aspirateur robot promo", category: "maison" },
];

async function runOnce() {
  for (const { q, category } of QUERIES) {
    try {
      const offers = await fetchShoppingResults(q);
      insertSnapshots(q.toLowerCase(), category, offers);
      console.log(`[${new Date().toISOString()}] ${q} : ${offers.length} offres enregistrées`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Échec sur "${q}" :`, e.message);
    }
    // Petite pause entre deux requêtes pour rester correct avec le quota SerpApi.
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Toutes les 30 minutes. Ajuste selon ton quota SerpApi (chaque ligne = 1 requête).
cron.schedule("*/30 * * * *", runOnce);

console.log("Cron RadarPrix démarré — scan toutes les 30 minutes.");
runOnce(); // premier scan immédiat au démarrage
