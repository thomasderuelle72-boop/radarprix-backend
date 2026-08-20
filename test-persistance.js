// Vérifie que les comptes survivent à la disparition du fichier de base —
// c'est-à-dire exactement ce qui se produisait à chaque déploiement.
//
// db.js est un module à instance unique : il ouvre la base au chargement. On
// ne peut donc pas simuler plusieurs démarrages dans un seul processus, d'où
// les processus enfants — chacun représente un déploiement.
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let echecs = 0;
const verifie = (l, c) => { console.log(c ? `✅ ${l}` : `❌ ÉCHEC — ${l}`); if (!c) echecs++; };

const bac = fs.mkdtempSync(path.join(os.tmpdir(), "radarprix-pers-"));
const DB = path.join(bac, "data", "radarprix.sqlite");

/** Un « déploiement » : un processus neuf qui charge db.js et exécute du code.
 *  Les deux flux sont renvoyés concaténés — les alertes de persistance partent
 *  en console.error, et ce sont justement elles qu'on vérifie. */
function demarrer(code) {
  const r = spawnSync(
    process.execPath,
    ["-e", `const db = require(${JSON.stringify(path.join(__dirname, "src/db.js"))}); ${code}`],
    { env: { ...process.env, DB_PATH: DB }, encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(`démarrage en échec :\n${r.stderr}`);
  return `${r.stdout}${r.stderr}`;
}

console.log("\n── Premier démarrage, puis création de comptes ──");
demarrer(`
  db.createUser("client1@radarprix.fr", "hash");
  db.createUser("client2@radarprix.fr", "hash");
  console.log("créés");
`);
verifie("Le fichier de base existe", fs.existsSync(DB));

console.log("\n── Deuxième démarrage : les comptes sont là, une sauvegarde est prise ──");
let sortie = demarrer(`console.log("COMPTES=" + db.etatPersistance().comptes);`);
verifie("Les deux comptes ont survécu au redémarrage", /COMPTES=2/.test(sortie));
const dossierSauv = path.join(bac, "data", "sauvegardes");
verifie("Une sauvegarde a été écrite", fs.existsSync(dossierSauv) && fs.readdirSync(dossierSauv).length > 0);

console.log("\n── Le déploiement efface la base (le scénario vécu) ──");
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
verifie("La base a bien disparu", !fs.existsSync(DB));

sortie = demarrer(`console.log("COMPTES=" + db.etatPersistance().comptes);`);
verifie("La disparition est signalée dans les journaux", /BASE DISPARUE/.test(sortie));
verifie("Les comptes sont restaurés automatiquement", /COMPTES=2/.test(sortie));

console.log("\n── Variante : la base revient vide au lieu de disparaître ──");
// Un fichier valide mais sans aucun compte : le serveur répondait normalement
// et servait un site vide, sans que rien ne le signale.
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
execFileSync(process.execPath, ["-e", `
  const D = require(${JSON.stringify(path.join(__dirname, "node_modules/better-sqlite3"))});
  const b = new D(${JSON.stringify(DB)});
  b.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)");
  b.close();
`], { encoding: "utf8" });
verifie("La base vide est en place", require("./src/persistance.js").compterComptes(DB) === 0);

sortie = demarrer(`console.log("COMPTES=" + db.etatPersistance().comptes);`);
verifie("La base vide est signalée", /BASE VIDE/.test(sortie));
verifie("Les comptes sont restaurés depuis la sauvegarde", /COMPTES=2/.test(sortie));

console.log("\n── La base courante n'est jamais supprimée, seulement mise de côté ──");
verifie(
  "Le fichier remplacé est conservé",
  fs.readdirSync(path.join(bac, "data")).some((f) => f.includes(".remplace-"))
);

console.log("\n── Une base qui porte des comptes n'est jamais écrasée ──");
sortie = demarrer(`
  db.createUser("client3@radarprix.fr", "hash");
  console.log("COMPTES=" + db.etatPersistance().comptes);
`);
verifie("Le troisième compte est ajouté", /COMPTES=3/.test(sortie));
sortie = demarrer(`console.log("COMPTES=" + db.etatPersistance().comptes);`);
verifie("Aucune restauration intempestive", !/RESTAURATION/.test(sortie) && /COMPTES=3/.test(sortie));

console.log("\n── Les vieilles sauvegardes sont élaguées ──");
const { COPIES_GARDEES } = require("./src/persistance.js");
for (let i = 0; i < COPIES_GARDEES + 4; i++) demarrer(`void 0;`);
const restantes = fs.readdirSync(dossierSauv).filter((f) => f.endsWith(".sqlite"));
verifie(
  `Exactement ${COPIES_GARDEES} sauvegardes conservées (${restantes.length})`,
  restantes.length === COPIES_GARDEES
);

fs.rmSync(bac, { recursive: true, force: true });
console.log(echecs === 0 ? "\nTous les tests passent." : `\n${echecs} test(s) en échec.`);
process.exit(echecs === 0 ? 0 : 1);
