// reinitialisation.js — Repartir d'une base saine sans perdre les comptes.
//
// Après plusieurs semaines de branchements successifs, la table des deals
// contenait un mélange dont plus personne ne pouvait dire l'origine :
// promotions d'enseignes inconnues, pages de rayon prises pour des produits,
// fiches surveillées qui ne rendront jamais de prix. Corriger les règles ne
// suffit pas — ce qui a été publié sous les anciennes règles y reste.
//
// Ce module efface le CONTENU produit par les détecteurs, et rien d'autre.
// Les comptes, le forum, la messagerie et les favoris ne sont jamais touchés :
// ce sont les seules données que personne ne peut régénérer.
const { db } = require("./db");

/* Ce qui est effaçable, et pourquoi. Une table absente est ignorée : les
   modules qui les créent ne sont pas tous chargés en toutes circonstances. */
const TABLES = [
  ["deals", "offres publiées par les détecteurs"],
  ["deal_feedback", "jugements de modération sur ces offres"],
  ["watched_urls", "fiches marchandes surveillées"],
  ["watched_prices", "relevés de prix de ces fiches"],
  ["collectes_scraper", "collectes Bright Data en cours"],
  ["snapshots", "observations des scans SerpApi"],
];

/** Tables réellement présentes dans la base. */
function tablesPresentes() {
  const noms = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
  );
  return TABLES.filter(([nom]) => noms.has(nom));
}

/** Ce que la remise à zéro effacerait, sans rien effacer. */
function apercu() {
  return tablesPresentes().map(([nom, quoi]) => ({
    table: nom,
    quoi,
    lignes: db.prepare(`SELECT COUNT(*) AS n FROM ${nom}`).get().n,
  }));
}

/**
 * Efface le contenu produit par les détecteurs.
 *
 * @param {object} opts
 * @param {boolean} [opts.garderHistorique] conserver snapshots et relevés de
 *   prix — l'historique met des jours à se reconstituer, et sans lui aucune
 *   anomalie n'est détectable avant plusieurs passages.
 * @returns {Array} lignes effacées par table
 */
function reinitialiser({ garderHistorique = false } = {}) {
  const protegees = garderHistorique ? new Set(["snapshots", "watched_prices"]) : new Set();
  const effacees = [];

  // En transaction : une remise à zéro à moitié faite laisserait des
  // relevés orphelins pointant vers des fiches disparues.
  const vider = db.transaction(() => {
    for (const [nom, quoi] of tablesPresentes()) {
      if (protegees.has(nom)) {
        effacees.push({ table: nom, quoi, lignes: 0, conservee: true });
        continue;
      }
      const avant = db.prepare(`SELECT COUNT(*) AS n FROM ${nom}`).get().n;
      db.prepare(`DELETE FROM ${nom}`).run();
      effacees.push({ table: nom, quoi, lignes: avant });
    }
  });
  vider();

  return effacees;
}

module.exports = { reinitialiser, apercu, TABLES };
