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
const { collecterTout } = require("./sources");
const { purgerDeals } = require("./dealsStore");

const BATCH_SIZE = parseInt(process.env.CRON_BATCH_SIZE || "10", 10);
const SCHEDULE = process.env.CRON_SCHEDULE || "0 */2 * * *"; // toutes les 2h par défaut

// La collecte des flux (jeux offerts, promotions, codes promo) a sa propre
// cadence, bien plus rapide : ces sources sont gratuites et illimitées,
// contrairement au scan SerpApi facturé à la requête. Les faire tourner à la
// même fréquence reviendrait à s'imposer la contrainte de la source la plus
// chère sur des sources qui n'en ont aucune.
const SCHEDULE_FLUX = process.env.CRON_FLUX_SCHEDULE || "*/30 * * * *"; // toutes les 30 min

async function tick() {
  const results = await runCatalogBatch(BATCH_SIZE);
  for (const r of results) {
    if (r.ok) console.log(`[${new Date().toISOString()}] ${r.name} (${r.category}) : ${r.offersFound} offres`);
    else console.error(`[${new Date().toISOString()}] Échec sur "${r.name}" :`, r.error);
  }
}

/** Collecte des flux D1 (promotions, codes) et D2 (gratuit). */
async function tickFlux() {
  try {
    const resultats = await collecterTout();
    for (const r of resultats) {
      if (r.ignoree) continue; // source sans identifiants : silencieux, voulu
      if (r.ok) console.log(`[${new Date().toISOString()}] flux ${r.nom} : ${r.collectes} offre(s), ${r.publies} publiée(s)`);
      else console.error(`[${new Date().toISOString()}] flux ${r.nom} en échec :`, r.erreur);
    }
    // La table des deals est en écriture continue : sans purge, elle grossit
    // indéfiniment avec des offres retirées que plus rien ne lit.
    const purges = purgerDeals();
    if (purges > 0) console.log(`[${new Date().toISOString()}] ${purges} deal(s) expiré(s) purgé(s)`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] collecte des flux en échec :`, e.message);
  }
}

function startCron() {
  cron.schedule(SCHEDULE, tick);
  cron.schedule(SCHEDULE_FLUX, tickFlux);
  console.log(`Cron RadarPrix démarré — ${BATCH_SIZE} produits toutes les exécutions (${SCHEDULE}).`);
  console.log(`Collecte des flux gratuits/promotions : ${SCHEDULE_FLUX}.`);
  console.log(`Catalogue total : ${PRODUCTS.length} produits.`);
  tick(); // premier lot immédiat au démarrage
  tickFlux();
}

module.exports = { startCron, tick, tickFlux };

// Lancé directement (`npm run cron`), et seulement dans ce cas : pas d'effet
// de bord au simple require() par server.js.
if (require.main === module) {
  require("dotenv").config();
  startCron();
}
