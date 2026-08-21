// radarEtat.js — Ce que le radar est en train de faire, dit publiquement.
//
// La plupart des sites de bons plans affirment leur fraîcheur sans jamais la
// prouver. RadarPrix peut faire mieux : la surveillance horodate chaque
// lecture, et ce module en tire un état vérifiable — combien de fiches sont
// suivies, quand a eu lieu le dernier balayage, combien d'anomalies sont
// actuellement publiées.
//
// C'est public et sans authentification, délibérément. L'information ne dit
// rien de sensible — ni quelles fiches, ni chez qui — et sa valeur tient
// justement à ce que n'importe quel visiteur puisse la lire. Le jour où le
// radar tombe en panne, elle le montre : une promesse qui se vérifie vaut
// mieux qu'une promesse qui se répète.
const { db } = require("./db");

/** Table présente ? Les modules qui les créent ne sont pas tous chargés. */
function existe(nom) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(nom));
}

/**
 * État courant du radar.
 *
 * @returns {{fiches:number, dernierBalayage:string|null, anomalies:number,
 *            deals:number, gratuits:number, actif:boolean}}
 */
function etatRadar() {
  const etat = {
    fiches: 0,
    dernierBalayage: null,
    anomalies: 0,
    deals: 0,
    gratuits: 0,
    actif: false,
  };

  if (existe("watched_urls")) {
    const r = db
      .prepare("SELECT COUNT(*) AS n, MAX(last_checked_at) AS dernier FROM watched_urls WHERE active = 1")
      .get();
    etat.fiches = r.n || 0;
    etat.dernierBalayage = r.dernier || null;
  }

  if (existe("deals")) {
    // Une seule requête plutôt qu'une par type : le compte par nature est
    // exactement ce qu'un GROUP BY sait faire, et cet endpoint est appelé à
    // chaque ouverture du menu.
    const parType = db
      .prepare(
        `SELECT type, COUNT(*) AS n FROM deals
         WHERE published_at IS NOT NULL AND removed_at IS NULL
           AND (expires_at IS NULL OR expires_at > datetime('now'))
         GROUP BY type`
      )
      .all();
    for (const { type, n } of parType) {
      if (type === "erreur") etat.anomalies = n;
      else if (type === "gratuit") etat.gratuits = n;
      else if (type === "promo" || type === "code") etat.deals += n;
    }
  }

  // « Actif » veut dire : le radar a balayé récemment. Deux heures de marge
  // couvrent un redéploiement et un intervalle manqué sans crier au loup.
  if (etat.dernierBalayage) {
    const ecartMs = Date.now() - new Date(`${etat.dernierBalayage.replace(" ", "T")}Z`).getTime();
    etat.actif = Number.isFinite(ecartMs) && ecartMs < 2 * 60 * 60 * 1000;
  }

  return etat;
}

module.exports = { etatRadar };
