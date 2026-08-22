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
const racine = (process.env.SCAN_URL || "").replace(/\/+$/, "");
const jeton = process.env.SCAN_TOKEN;

if (!racine || !jeton) {
  console.error("[cron] SCAN_URL et SCAN_TOKEN sont requis.");
  process.exit(1);
}

// Le serveur répond aussitôt et poursuit le scan en arrière-plan : ce délai
// couvre l'accusé de réception, pas la durée du scan lui-même.
const minuteur = AbortSignal.timeout(30_000);

fetch(`${racine}/api/admin/scan`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-scan-token": jeton },
  body: "{}",
  signal: minuteur,
})
  .then(async (r) => {
    const corps = await r.text();
    if (!r.ok) {
      // Sortir en erreur donne au tableau de bord Railway un échec visible
      // plutôt qu'une exécution verte qui n'a rien scanné.
      console.error(`[cron] refus du serveur (${r.status}) : ${corps.slice(0, 300)}`);
      process.exit(1);
    }
    console.log(`[cron] scan lancé : ${corps.slice(0, 300)}`);
  })
  .catch((e) => {
    console.error(`[cron] appel impossible : ${e.message}`);
    process.exit(1);
  });
