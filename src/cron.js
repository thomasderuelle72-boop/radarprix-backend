// cron.js — Scanne le catalogue en tâche de fond pour construire le pool
// de "deals du moment" que le site sert ensuite instantanément (voir
// /api/deals dans server.js). C'est CE script qui consomme le quota
// SerpApi, pas les visiteurs du site.
//
// ⚠️ Sur le plan gratuit SerpApi (~100 requêtes/mois), scanner tout le
// catalogue plusieurs fois par jour n'est pas tenable. Ajuste
// CRON_SCHEDULE et CRON_BATCH_SIZE selon ton quota réel.
//
// Deux façons de le lancer :
//  - en tâche de fond séparée : `npm run cron` (exécute ce fichier directement) ;
//  - dans le même process que le serveur web, via startCron() — voir server.js,
//    activé par la variable d'env ENABLE_CRON=true (utile sur un hébergeur qui
//    ne fait tourner qu'un seul service, comme Railway sur le plan actuel).
const cron = require("node-cron");
const { runCatalogBatch, PRODUCTS } = require("./scanBatch");

const BATCH_SIZE = parseInt(process.env.CRON_BATCH_SIZE || "10", 10);
const SCHEDULE = process.env.CRON_SCHEDULE || "0 */2 * * *"; // toutes les 2h par défaut

async function tick() {
  const results = await runCatalogBatch(BATCH_SIZE);
  for (const r of results) {
    if (r.ok) console.log(`[${new Date().toISOString()}] ${r.name} (${r.category}) : ${r.offersFound} offres`);
    else console.error(`[${new Date().toISOString()}] Échec sur "${r.name}" :`, r.error);
  }
}

function startCron() {
  cron.schedule(SCHEDULE, tick);
  console.log(`Cron RadarPrix démarré — ${BATCH_SIZE} produits toutes les exécutions (${SCHEDULE}).`);
  console.log(`Catalogue total : ${PRODUCTS.length} produits.`);
  tick(); // premier lot immédiat au démarrage
}

module.exports = { startCron };

// Lancé directement (`npm run cron`), et seulement dans ce cas : pas d'effet
// de bord au simple require() par server.js.
if (require.main === module) {
  require("dotenv").config();
  startCron();
}
