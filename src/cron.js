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
const { surveiller } = require("./watch");
const { sauvegarderMaintenant } = require("./db");
const { peupler } = require("./peuplement");
const { tourComplet: tourScraper } = require("./scraperRun");
const { estActif, annoncerPilotage } = require("./pilotage");

const BATCH_SIZE = parseInt(process.env.CRON_BATCH_SIZE || "10", 10);
const SCHEDULE = process.env.CRON_SCHEDULE || "0 */2 * * *"; // toutes les 2h par défaut

// La collecte des flux (jeux offerts, promotions, codes promo) a sa propre
// cadence, bien plus rapide : ces sources sont gratuites et illimitées,
// contrairement au scan SerpApi facturé à la requête. Les faire tourner à la
// même fréquence reviendrait à s'imposer la contrainte de la source la plus
// chère sur des sources qui n'en ont aucune.
const SCHEDULE_FLUX = process.env.CRON_FLUX_SCHEDULE || "*/30 * * * *"; // toutes les 30 min

// La surveillance des fiches marchandes est la cadence qui compte vraiment :
// c'est elle qui décide si une erreur de prix vivant vingt minutes est vue ou
// manquée. Toutes les quinze minutes, la probabilité de capture passe de ~2 %
// à un ordre de grandeur tout autre — et cela ne coûte que de la bande
// passante, puisqu'on lit les fiches et non une API facturée à la requête.
const SCHEDULE_WATCH = process.env.CRON_WATCH_SCHEDULE || "*/15 * * * *";

// La sauvegarde de la base ne tournait qu'à l'ouverture du fichier, donc en
// pratique une fois par déploiement. Un service qui tient trois semaines sans
// redéploiement n'avait donc qu'une copie vieille de trois semaines — ce qui
// répond mal à la seule question qui compte le jour où on en a besoin.
// Une copie par nuit, à une heure creuse choisie hors des minutes rondes pour
// ne pas tomber en même temps que le reste.
const SCHEDULE_BACKUP = process.env.CRON_BACKUP_SCHEDULE || "37 4 * * *";

// Découverte de nouvelles fiches chez les marchands, par petits lots. Plus
// lente que la surveillance : une fiche découverte le reste, alors qu'un prix
// doit être relu souvent. Deux enseignes par passage, en rotation — avaler un
// sitemap entier saturerait la base et ressemblerait à une attaque vue du
// marchand.
const SCHEDULE_DECOUVERTE = process.env.CRON_DECOUVERTE_SCHEDULE || "23 */3 * * *";

// Extracteurs Bright Data. Cadence lente et facturée au produit : on ne
// cherche pas ici la fraîcheur du prix — c'est le rôle de la surveillance —
// mais une lecture structurée fiable, là où nos propres motifs échouent.
const SCHEDULE_SCRAPER = process.env.CRON_SCRAPER_SCHEDULE || "41 */6 * * *";

// Le scan SerpApi s'arrête de lui-même quand le quota mensuel est épuisé.
// Sans ça, chaque passage relançait dix requêtes vouées à répondre 429, dont
// chacune tentait ensuite un repli lui aussi en échec : vingt lignes d'erreur
// toutes les deux heures, qui noient les vraies pannes dans les journaux.
let quotaSerpApiEpuise = false;

async function tick() {
  if (!estActif("catalogue") || quotaSerpApiEpuise) return;
  const results = await runCatalogBatch(BATCH_SIZE);
  if (results.length > 0 && results.every((r) => !r.ok && /run out of searches|429/i.test(r.error || ""))) {
    quotaSerpApiEpuise = true;
    console.warn(
      `[${new Date().toISOString()}] quota SerpApi épuisé — scan catalogue suspendu jusqu'au prochain redémarrage. ` +
        `Les autres sources (découverte, surveillance, flux) continuent normalement.`
    );
    return;
  }
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

/** Surveillance des fiches marchandes (détecteur D3, erreurs de prix). */
async function tickWatch() {
  if (!estActif("watch")) return;
  try {
    const resultats = await surveiller();
    if (resultats.length === 0) return; // aucune fiche surveillée pour l'instant
    const anomalies = resultats.filter((r) => r.verdict && r.verdict !== "normal");
    console.log(
      `[${new Date().toISOString()}] surveillance : ${resultats.filter((r) => r.ok).length}/${resultats.length} fiche(s), ${anomalies.length} anomalie(s)`
    );
    for (const a of anomalies) {
      console.log(`  → ${a.verdict.toUpperCase()} ${a.prix}€ (réf ${Math.round(a.reference)}€) ${a.url}`);
    }
    for (const d of resultats.filter((r) => r.desactivee)) {
      console.log(`  ⨯ fiche désactivée après échecs répétés : ${d.url} (${d.erreur})`);
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] surveillance en échec :`, e.message);
  }
}

/** Découverte automatique de fiches produits via les sitemaps marchands. */
async function tickDecouverte() {
  if (!estActif("sitemap")) return;
  try {
    const resultats = await peupler();
    for (const r of resultats) {
      if (r.ignore) {
        console.log(`[${new Date().toISOString()}] découverte ignorée : ${r.motif}`);
      } else if (r.ok) {
        // « 0 ajoutée » ne disait pas si le marchand a refusé la requête, si
        // son sitemap est vide, ou si aucune adresse ne ressemblait à une
        // fiche. Trois pannes distinctes qu'un compteur unique confondait.
        console.log(
          `[${new Date().toISOString()}] découverte ${r.enseigne} : ${r.ajoutees} nouvelle(s), ` +
            `${r.trouvees} reconnue(s), ${r.sitemapsLus} sitemap(s) lu(s)`
        );
        for (const err of r.erreurs || []) {
          console.error(`[${new Date().toISOString()}]   ↳ ${r.enseigne} : ${err}`);
        }
        // Un « 0 reconnue » ne dit rien de la forme des adresses du marchand.
        // Sans cet échantillon, on corrige les règles à l'aveugle.
        for (const vue of r.echantillonVu || []) {
          console.log(`[${new Date().toISOString()}]   • vu : ${vue}`);
        }
      } else {
        console.error(`[${new Date().toISOString()}] découverte ${r.enseigne} en échec :`, r.erreur);
      }
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] découverte en échec :`, e.message);
  }
}

/** Extracteurs Bright Data : récupère les collectes prêtes, en relance. */
async function tickScraper() {
  if (!estActif("scraper")) return;
  try {
    const { recuperees, declenchees } = await tourScraper();
    for (const r of recuperees) {
      if (r.enCours) continue; // silencieux : c'est l'état normal d'une collecte jeune
      if (r.erreur) console.error(`[${new Date().toISOString()}] extraction ${r.marchand} en échec :`, r.erreur);
      else console.log(`[${new Date().toISOString()}] extraction ${r.marchand} : ${r.publies} produit(s) publié(s)`);
    }
    for (const d of declenchees) {
      if (d.ignore) console.log(`[${new Date().toISOString()}] extraction ${d.marchand} ignorée : ${d.motif}`);
      else if (d.erreur) console.error(`[${new Date().toISOString()}] déclenchement ${d.marchand} en échec :`, d.erreur);
      else console.log(`[${new Date().toISOString()}] extraction ${d.marchand} déclenchée sur ${d.urls} fiche(s)`);
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] extraction en échec :`, e.message);
  }
}

/** Copie de sécurité de la base, indépendante des redéploiements. */
function tickBackup() {
  try {
    const { sauvegardes } = sauvegarderMaintenant();
    console.log(`[${new Date().toISOString()}] sauvegarde effectuée — ${sauvegardes.length} copie(s) conservée(s)`);
  } catch (e) {
    // Comme au démarrage : une sauvegarde ratée ne doit rien interrompre.
    console.error(`[${new Date().toISOString()}] sauvegarde en échec :`, e.message);
  }
}

function startCron() {
  annoncerPilotage();
  cron.schedule(SCHEDULE, tick);
  cron.schedule(SCHEDULE_FLUX, tickFlux);
  cron.schedule(SCHEDULE_WATCH, tickWatch);
  cron.schedule(SCHEDULE_BACKUP, tickBackup);
  cron.schedule(SCHEDULE_DECOUVERTE, tickDecouverte);
  cron.schedule(SCHEDULE_SCRAPER, tickScraper);
  console.log(`Cron RadarPrix démarré — ${BATCH_SIZE} produits toutes les exécutions (${SCHEDULE}).`);
  console.log(`Collecte des flux gratuits/promotions : ${SCHEDULE_FLUX}.`);
  console.log(`Surveillance des fiches marchandes : ${SCHEDULE_WATCH}.`);
  console.log(`Sauvegarde de la base : ${SCHEDULE_BACKUP}.`);
  console.log(`Découverte de fiches marchandes : ${SCHEDULE_DECOUVERTE}.`);
  console.log(`Extracteurs Bright Data : ${SCHEDULE_SCRAPER}.`);
  console.log(`Catalogue total : ${PRODUCTS.length} produits.`);
  tick(); // premier lot immédiat au démarrage
  tickFlux();
  tickWatch();
  tickDecouverte(); // premier peuplement immédiat : le site ne doit pas rester vide
}

module.exports = { startCron, tick, tickFlux, tickWatch, tickDecouverte, tickScraper };

// Lancé directement (`npm run cron`), et seulement dans ce cas : pas d'effet
// de bord au simple require() par server.js.
if (require.main === module) {
  require("dotenv").config();
  startCron();
}
