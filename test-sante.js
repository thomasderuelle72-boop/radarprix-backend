// Vérifie le suivi de santé : journal des scans, état des sources,
// journal des emails et purge des lignes anciennes.
const {
  db, debuterScan, terminerScan, listScanRuns,
  logSourceEvent, sourceHealth, logEmail, listEmailLog, emailStats, purgerJournaux,
  createUser,
} = require("./src/db");

let echecs = 0;
const verifie = (l, c) => { console.log(c ? `✅ ${l}` : `❌ ÉCHEC — ${l}`); if (!c) echecs++; };
const etat = (source) => sourceHealth().find((s) => s.source === source);

const admin = createUser("admin@t.fr", "x");

console.log("── Journal des scans ──");
const run = debuterScan("manuel", 10, admin.id);
verifie("Exécution ouverte", typeof run === "number");
let liste = listScanRuns();
verifie("Elle apparaît immédiatement", liste.length === 1 && liste[0].finished_at === null);
verifie("Son auteur est joint", liste[0].lance_par === "admin@t.fr");
terminerScan(run, { okCount: 7, failCount: 3, offersCount: 84, error: "quota épuisé" });
liste = listScanRuns();
verifie("Le bilan est enregistré", liste[0].ok_count === 7 && liste[0].fail_count === 3 && liste[0].offers_count === 84);
verifie("La date de fin est posée", liste[0].finished_at !== null);
verifie("La première erreur est retenue", liste[0].error === "quota épuisé");
terminerScan(debuterScan("cron", 10, null), { okCount: 10, offersCount: 120 });
verifie("Un scan du cron n'a pas d'auteur", listScanRuns()[0].lance_par === null);
verifie("Du plus récent au plus ancien", listScanRuns()[0].id > listScanRuns()[1].id);

console.log("\n── État des sources ──");
verifie("Sans aucun appel, l'état est « inconnu »", etat("serpapi").etat === "inconnu");
verifie("Les trois sources sont décrites", sourceHealth().length === 3);

logSourceEvent("serpapi", true, "12 offres");
verifie("Un succès rend l'état « ok »", etat("serpapi").etat === "ok");
verifie("Le dernier succès est daté", etat("serpapi").dernierSucces !== null);
verifie("Aucun échec pour l'instant", etat("serpapi").dernierEchec === null);

for (let i = 0; i < 3; i++) logSourceEvent("serpapi", false, "Your account has run out of searches.");
verifie("Trois échecs d'affilée : état « instable »", etat("serpapi").etat === "instable");
verifie("La série d'échecs est comptée", etat("serpapi").serieEchecs === 3);
verifie("Le dernier message d'erreur est conservé", etat("serpapi").dernierMessage.includes("run out of searches"));

for (let i = 0; i < 2; i++) logSourceEvent("serpapi", false, "quota");
verifie("Cinq échecs d'affilée : état « panne »", etat("serpapi").etat === "panne");
logSourceEvent("serpapi", true, "revenu");
verifie("Un succès remet l'état à « ok »", etat("serpapi").etat === "ok");
verifie("La série d'échecs est remise à zéro", etat("serpapi").serieEchecs === 0);
verifie("Le dernier échec reste consultable", etat("serpapi").dernierEchec !== null);
verifie("Les appels des 24 h sont comptés", etat("serpapi").appels24h === 7);
verifie("Les succès des 24 h aussi", etat("serpapi").succes24h === 2);
verifie("Une source jamais appelée reste « inconnu »", etat("brightdata").etat === "inconnu");

console.log("\n── Journal des emails ──");
logEmail({ to: "a@t.fr", subject: "Erreur de prix", motif: "erreur", ok: true });
logEmail({ to: "b@t.fr", subject: "Prix cible", motif: "seuil", ok: true });
logEmail({ to: "c@t.fr", subject: "Erreur de prix", motif: "erreur", ok: false, error: "422 domaine non vérifié" });
const journal = listEmailLog();
verifie("Trois envois consignés", journal.length === 3);
verifie("Du plus récent au plus ancien", journal[0].to_email === "c@t.fr");
verifie("L'échec conserve sa raison", journal[0].error.includes("422"));
const stats = emailStats();
console.log(`  ${stats.envoyes7j}/${stats.total7j} envoyés, ${stats.echecs7j} échec(s)`);
verifie("Le bilan compte les envois", stats.total7j === 3 && stats.envoyes7j === 2 && stats.echecs7j === 1);

console.log("\n── Purge des lignes anciennes ──");
const vieux = "datetime('now', '-60 day')";
db.prepare(`INSERT INTO email_log (to_email, ok, created_at) VALUES ('vieux@t.fr', 1, ${vieux})`).run();
db.prepare(`INSERT INTO source_events (source, ok, created_at) VALUES ('serpapi', 1, ${vieux})`).run();
db.prepare(`INSERT INTO scan_runs (source, size, started_at) VALUES ('cron', 10, ${vieux})`).run();
verifie("Les vieilles lignes sont bien présentes avant purge", listEmailLog().length === 4);
purgerJournaux();
verifie("Email ancien purgé", listEmailLog().length === 3);
verifie("Scan ancien purgé", listScanRuns().every((r) => r.started_at > "2026-01-01"));
verifie("Les lignes récentes sont conservées", etat("serpapi").appels24h === 7);

console.log(`\n${echecs === 0 ? "Tous les tests passent." : echecs + " test(s) en échec."}`);
db.close();
process.exit(echecs === 0 ? 0 : 1);
