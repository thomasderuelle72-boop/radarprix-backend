// pilotage.js — Décider ce qui tourne, explicitement.
//
// Les sources se sont accumulées une par une, chacune s'activant dès qu'une
// clé était présente. Résultat : impossible de dire ce qui remplissait le
// site à un instant donné, ni d'éteindre une source douteuse sans retirer
// ses identifiants — donc sans casser autre chose.
//
// Le contrôle passe ici, en un seul endroit et par un seul réglage. Rien ne
// s'exécute qui n'ait été nommé. Une clé présente ne suffit plus : c'est une
// condition nécessaire, plus une condition suffisante.
//
// DETECTEURS_ACTIFS="epic,awin" — liste séparée par des virgules.
// Absente ou vide : aucune source ne tourne, et le serveur le dit au
// démarrage plutôt que de laisser croire à une panne.

/** Tout ce qui peut être allumé, avec ce que ça déclenche réellement. */
const PILOTABLES = {
  epic: "Jeux offerts (Epic Games) — gratuit, aucune clé",
  awin: "Promotions et codes promo (Awin) — nécessite AWIN_API_TOKEN",
  strackr: "Promotions agrégées (Strackr) — nécessite STRACKR_API_KEY",
  ebay: "Prix du marché français (eBay) — nécessite EBAY_APP_ID / EBAY_CERT_ID",
  scraper: "Extracteurs Bright Data — nécessite BRIGHT_DATA_DATASETS",
  sitemap: "Découverte de fiches par les sitemaps marchands",
  watch: "Surveillance des fiches et détection d'anomalies",
  catalogue: "Scan SerpApi du catalogue — nécessite SERPAPI_KEY",
};

function listeActive() {
  return (process.env.DETECTEURS_ACTIFS || "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Ce détecteur doit-il tourner ?
 *
 * Volontairement strict : un nom inconnu ne l'active pas, et une liste vide
 * n'active rien. On préfère un site silencieux à un site qui se remplit sans
 * qu'on sache d'où — c'est précisément ce qu'on cherche à ne plus revivre.
 */
function estActif(nom) {
  return listeActive().includes(String(nom).toLowerCase());
}

/** État complet, pour le tableau de bord et les journaux de démarrage. */
function etatPilotage() {
  const actifs = listeActive();
  return {
    actifs,
    inconnus: actifs.filter((n) => !PILOTABLES[n]),
    disponibles: Object.entries(PILOTABLES).map(([nom, libelle]) => ({
      nom,
      libelle,
      actif: actifs.includes(nom),
    })),
  };
}

/** Résumé lisible, écrit une fois au démarrage. */
function annoncerPilotage(log = console.log) {
  const { actifs, inconnus } = etatPilotage();
  if (actifs.length === 0) {
    log(
      "⚠️  Aucun détecteur actif. Le site ne se remplira pas tant que " +
        "DETECTEURS_ACTIFS n'est pas défini. Valeurs possibles : " +
        Object.keys(PILOTABLES).join(", ")
    );
    return;
  }
  log(`Détecteurs actifs : ${actifs.join(", ")}`);
  for (const nom of inconnus) {
    log(`⚠️  "${nom}" n'est pas un détecteur connu — ignoré.`);
  }
}

module.exports = { estActif, etatPilotage, annoncerPilotage, PILOTABLES };
