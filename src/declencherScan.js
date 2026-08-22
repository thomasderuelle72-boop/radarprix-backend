#!/usr/bin/env node
// Déclencheur de scan à distance — la commande d'un service cron Railway.
//
// Pourquoi passer par HTTP plutôt que par `npm run scan` : la base SQLite
// vit sur un volume, et un volume Railway ne se monte que sur un seul
// service. Un service cron distinct n'a donc aucun moyen de l'ouvrir. Il
// réveille le serveur qui, lui, la détient.
//
// Le jeton x-scan-token existe précisément pour cet appel : il évite de
// stocker un mot de passe admin dans un service dont le seul travail est
// de sonner à la porte toutes les trois heures.
//
// Variables attendues : SCAN_URL (racine de l'API) et SCAN_TOKEN.

/**
 * Sursis avant de rendre la main.
 *
 * Un conteneur qui vit deux secondes disparaît avant que Railway n'ait
 * expédié sa sortie : le premier essai s'est terminé en SUCCESS sans une
 * seule ligne de journal, donc sans aucun moyen de savoir si le scan était
 * parti. Ce répit est la seule chose qui rend les exécutions du cron
 * lisibles depuis le tableau de bord — c'est-à-dire vérifiables.
 */
const repit = () => new Promise((r) => setTimeout(r, 15_000));

/** Termine en laissant à la plateforme le temps de récupérer la sortie. */
async function finir(code) {
  await repit();
  process.exit(code);
}

async function main() {
  const racine = (process.env.SCAN_URL || "").replace(/\/+$/, "");
  const jeton = process.env.SCAN_TOKEN;

  if (!racine || !jeton) {
    console.error("[cron] SCAN_URL et SCAN_TOKEN sont requis.");
    return finir(1);
  }

  let reponse;
  try {
    reponse = await fetch(`${racine}/api/admin/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-scan-token": jeton },
      body: "{}",
      // Le serveur répond aussitôt et poursuit le scan en arrière-plan : ce
      // délai couvre l'accusé de réception, pas la durée du scan lui-même.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    console.error(`[cron] appel impossible : ${e.message}`);
    return finir(1);
  }

  const corps = (await reponse.text()).slice(0, 300);
  if (!reponse.ok) {
    // Sortir en erreur donne au tableau de bord Railway un échec visible
    // plutôt qu'une exécution verte qui n'a rien scanné.
    console.error(`[cron] refus du serveur (${reponse.status}) : ${corps}`);
    return finir(1);
  }

  console.log(`[cron] scan lancé : ${corps}`);
  return finir(0);
}

main();
