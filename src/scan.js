// scan.js — Déclenche un scan complet depuis la ligne de commande ou le
// planificateur de l'hébergeur (Railway cron, cron-job.org…).
//
// Usage :
//   npm run scan                      # un scan de toutes les cibles actives
//   SCAN_SOURCE=manuel npm run scan   # étiqueter l'exécution autrement
//
// Le scan est synchrone : le processus ne se termine qu'une fois toutes les
// cibles traitées, ce qui permet au planificateur de savoir si cela a
// réussi (code de sortie 0) ou non (code de sortie 1).
require("./env");
const { lancerScan } = require("./collect");
const { fermerBase } = require("./db");

async function main() {
  const source = process.env.SCAN_SOURCE || "cron";
  let code = 0;
  try {
    const bilan = await lancerScan({ source });
    console.log(`[scan] ${bilan.cibles} cible(s) — ${bilan.offres} offre(s) collectée(s), ` +
      `${bilan.analyses} anomalie(s), ${bilan.publies} publiée(s), ` +
      `${bilan.ignorees} écartée(s) faute de vendeur ou de visuel, ${bilan.erreurs} erreur(s).`);
    if (bilan.details.some((d) => d.erreur)) {
      for (const d of bilan.details.filter((x) => x.erreur)) {
        console.warn(`[scan] cible #${d.cible} (${d.requete}) : ${d.erreur}`);
      }
    }
    code = bilan.erreurs > 0 ? 1 : 0;
  } catch (e) {
    console.error(`[scan] échec : ${e.message}`);
    code = 1;
  } finally {
    try {
      fermerBase();
    } catch {
      // La base peut déjà être fermée : rien à faire de plus.
    }
  }
  // Le code de sortie n'est écrit qu'une fois, tout le travail terminé :
  // l'avertissement du linter sur les écritures atomiques ne s'applique pas.
  // eslint-disable-next-line require-atomic-updates
  process.exitCode = code;
}

main();
