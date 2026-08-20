// persistance.js — Protection du fichier de base contre les pertes au
// déploiement.
//
// Le problème vécu : à chaque mise à jour, tous les comptes disparaissaient.
// La base est un simple fichier SQLite ; s'il n'atterrit pas dans le volume
// persistant de l'hébergeur, il vit et meurt avec le conteneur. Et surtout,
// rien ne le signalait : le serveur redémarrait, recréait un fichier vide, et
// répondait normalement. La perte était totale et silencieuse.
//
// Ce module fait trois choses, dans cet ordre d'importance :
//   1. il dit à voix haute où la base est écrite et ce qu'elle contient ;
//   2. il garde des copies horodatées à côté d'elle ;
//   3. si la base a disparu ou est repartie vide alors qu'une copie contient
//      des comptes, il restaure la copie au lieu de démarrer sur du vide.
//
// Le point 3 est le filet réel : même si la cause première revenait, les
// comptes reviendraient avec. Le point 1 est ce qui permet de diagnostiquer
// sans deviner.
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// Assez pour couvrir plusieurs jours de déploiements successifs, sans laisser
// le volume se remplir indéfiniment.
const COPIES_GARDEES = 15;

// Millisecondes comprises : deux démarrages dans la même seconde — un
// redéploiement suivi d'un redémarrage — écriraient sinon le même fichier,
// et la sauvegarde précédente serait perdue au moment où elle sert le plus.
const horodatage = () =>
  new Date().toISOString().replace(/[-:]/g, "").replace(/\.(\d+)Z$/, "-$1").replace("T", "-");

const dossierSauvegardes = (dbPath) => path.join(path.dirname(dbPath), "sauvegardes");

/** Les fichiers annexes du mode WAL. Ils doivent suivre la base ou disparaître
 *  avec elle : un -wal orphelin appliqué sur une base restaurée corromprait
 *  les deux. */
const annexes = (dbPath) => [`${dbPath}-wal`, `${dbPath}-shm`];

/** Les sauvegardes présentes, de la plus récente à la plus ancienne. */
function listerSauvegardes(dbPath) {
  const dossier = dossierSauvegardes(dbPath);
  if (!fs.existsSync(dossier)) return [];
  return fs
    .readdirSync(dossier)
    .filter((f) => f.endsWith(".sqlite"))
    .map((f) => {
      const complet = path.join(dossier, f);
      const st = fs.statSync(complet);
      return { fichier: f, chemin: complet, taille: st.size, date: st.mtime.toISOString() };
    })
    .sort((a, b) => b.fichier.localeCompare(a.fichier));
}

/** Nombre de comptes dans un fichier SQLite quelconque, sans le modifier.
 *  Renvoie null si le fichier est illisible ou n'a pas encore de table users
 *  — on ne veut surtout pas qu'une sauvegarde abîmée fasse échouer le
 *  démarrage. */
function compterComptes(chemin) {
  let base = null;
  try {
    base = new Database(chemin, { readonly: true, fileMustExist: true });
    const r = base.prepare("SELECT COUNT(*) AS n FROM users").get();
    return r ? r.n : null;
  } catch {
    return null;
  } finally {
    try { base?.close(); } catch { /* rien à faire de plus */ }
  }
}

/** Remet une sauvegarde en place. L'éventuel fichier courant est mis de côté
 *  plutôt que supprimé : si la restauration était une erreur, rien n'est
 *  définitivement perdu. */
function restaurer(dbPath, sauvegarde) {
  if (fs.existsSync(dbPath)) {
    const misDeCote = `${dbPath}.remplace-${horodatage()}`;
    fs.renameSync(dbPath, misDeCote);
    console.warn(`[persistance] base courante mise de côté : ${misDeCote}`);
  }
  for (const f of annexes(dbPath)) if (fs.existsSync(f)) fs.rmSync(f);
  fs.copyFileSync(sauvegarde.chemin, dbPath);
  console.warn(`[persistance] RESTAURATION depuis ${sauvegarde.fichier}`);
}

/**
 * À appeler AVANT d'ouvrir la base. Décide s'il faut restaurer, et le fait.
 *
 * Tout se joue ici plutôt qu'après l'ouverture : remplacer le fichier pendant
 * que SQLite le tient ouvert obligerait à fermer puis rouvrir la connexion
 * déjà exportée par db.js. Avant ouverture, un simple copyFileSync suffit.
 */
function preparerBase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const existe = fs.existsSync(dbPath);
  const taille = existe ? fs.statSync(dbPath).size : 0;
  // null = fichier absent ou schéma pas encore créé : on ne sait pas, et on
  // se garde bien d'en conclure quoi que ce soit.
  const comptes = existe && taille > 0 ? compterComptes(dbPath) : null;

  console.log(`[persistance] base : ${dbPath}`);
  console.log(
    existe
      ? `[persistance] fichier présent (${(taille / 1024).toFixed(1)} ko, ${comptes === null ? "schéma absent" : comptes + " compte(s)"})`
      : "[persistance] aucun fichier — première exécution, ou fichier perdu"
  );

  // Une base qui porte déjà des comptes n'a évidemment rien à restaurer.
  if (comptes > 0) return;

  const candidate = listerSauvegardes(dbPath).find((s) => (compterComptes(s.chemin) || 0) > 0);
  if (!candidate) {
    console.log("[persistance] aucune sauvegarde exploitable — démarrage sur une base neuve");
    return;
  }

  // Deux cas mènent ici, et ce sont les deux visages du même incident :
  // le fichier a disparu, ou il est revenu vide.
  console.error(
    existe && taille > 0
      ? "[persistance] BASE VIDE alors qu'une sauvegarde contient des comptes"
      : "[persistance] BASE DISPARUE"
  );
  restaurer(dbPath, candidate);
}

/**
 * À appeler APRÈS l'ouverture et la création du schéma : prend une copie de
 * l'état courant et élague les plus anciennes.
 *
 * Renvoie un compte rendu, que le panneau d'administration affiche — sans ça,
 * il faudrait aller lire les journaux de l'hébergeur pour savoir si les
 * données tiennent d'un déploiement à l'autre.
 */
function sauvegarderBase(db, dbPath) {
  const comptes = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  console.log(`[persistance] ${comptes} compte(s) en base après ouverture`);

  // Rien à sauvegarder d'une base vide, et surtout : une copie vide viendrait
  // se placer en tête de liste et masquerait les copies utiles.
  if (comptes === 0) {
    return { chemin: dbPath, comptes, sauvegardes: listerSauvegardes(dbPath) };
  }

  try {
    // Le checkpoint vide le journal WAL dans le fichier principal : sans lui,
    // une copie brute laisserait les dernières écritures derrière elle.
    db.pragma("wal_checkpoint(TRUNCATE)");
    const dossier = dossierSauvegardes(dbPath);
    fs.mkdirSync(dossier, { recursive: true });
    const cible = path.join(dossier, `radarprix-${horodatage()}.sqlite`);
    fs.copyFileSync(dbPath, cible);
    console.log(`[persistance] sauvegarde écrite : ${path.basename(cible)}`);

    for (const vieille of listerSauvegardes(dbPath).slice(COPIES_GARDEES)) {
      fs.rmSync(vieille.chemin);
    }
  } catch (e) {
    // Une sauvegarde ratée ne doit jamais empêcher le site de démarrer.
    console.error(`[persistance] sauvegarde impossible : ${e.message}`);
  }

  return { chemin: dbPath, comptes, sauvegardes: listerSauvegardes(dbPath) };
}

module.exports = {
  COPIES_GARDEES,
  preparerBase,
  sauvegarderBase,
  listerSauvegardes,
  compterComptes,
  restaurer,
  dossierSauvegardes,
};
