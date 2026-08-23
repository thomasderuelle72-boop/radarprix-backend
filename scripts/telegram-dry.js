// telegram-dry.js — Montre ce qui serait envoyé, sans rien envoyer.
//
// Force la simulation quoi que dise l'environnement : ce script doit pouvoir
// tourner en local sans risquer une publication sur le canal public.
process.env.TELEGRAM_DRY_RUN = "true";
process.env.TELEGRAM_ENABLED = "true";
process.env.JWT_SECRET = process.env.JWT_SECRET || "simulation";

const telegram = require("../src/telegram");

const e = telegram.etat();
console.log(`\nCanal   : ${e.canal}`);
/* etat() rend « désactivé » sans jeton, ce qui est juste pour le tableau de
   bord mais trompeur ici : la simulation n'a besoin d'aucun jeton, puisque
   rien n'est envoyé. On dit ce que fait CE script. */
console.log(`Mode    : simulation — rien ne sera envoyé${e.reglages.token === "absent" ? " (aucun jeton configuré, sans importance ici)" : ""}`);
console.log(`Publiés aujourd'hui : ${e.postsAujourdHui} / ${e.capJournalier}\n`);

const lot = telegram.candidats(e.capJournalier);
if (!lot.length) {
  console.log("Aucune offre éligible avec les réglages actuels.");
  console.log(`Rappel des seuils : remise >= ${e.reglages.remiseMin} %, prix >= ${e.reglages.prixMin} €, ` +
              `vendeurs >= ${e.reglages.vendeursMin}, détectée depuis >= ${e.reglages.delaiMinutes} min.\n`);
  process.exit(0);
}

console.log(`${lot.length} offre(s) seraient publiées :\n${"═".repeat(64)}`);
for (const d of lot) {
  console.log(telegram.formaterMessage(d));
  console.log("═".repeat(64));
}
