// Vérifie l'envoi d'alertes email : un membre qui suit un produit reçoit une
// alerte quand une "erreur" de prix est détectée, pas de re-envoi tant que
// le prix ne change pas, et un nouveau prix plus bas déclenche un nouvel envoi.
process.env.SERPAPI_KEY = "fake";
process.env.JWT_SECRET = "test-secret";
process.env.RESEND_API_KEY = "fake-resend-key";

const { createUser, addToWatchlist, insertSnapshots } = require("./src/db");
const { notifyWatchers } = require("./src/scanBatch");

// On intercepte fetch pour ne jamais appeler le vrai réseau et compter les envois.
let sentCount = 0;
let lastBody = null;
global.fetch = async (url, opts) => {
  sentCount++;
  lastBody = JSON.parse(opts.body);
  return { ok: true, json: async () => ({}) };
};

async function main() {
  const u = createUser("watcher@test.com", "hash");
  addToWatchlist(u.id, "PC portable gamer");

  // Historique : prix habituel autour de 1000€, plusieurs points pour une référence solide.
  insertSnapshots("pc portable gamer", "informatique", [
    { name: "PC portable gamer", seller: "Amazon", price: 999, url: "https://x/1" },
    { name: "PC portable gamer", seller: "Amazon", price: 1010, url: "https://x/1" },
    { name: "PC portable gamer", seller: "Fnac", price: 995, url: "https://x/1" },
  ]);

  console.log("── Erreur de prix détectée : alerte envoyée une fois ──");
  await notifyWatchers("PC portable gamer", [
    { name: "PC portable gamer", seller: "Cdiscount", price: 350, url: "https://x/2" },
  ]);
  console.log(`  emails envoyés : ${sentCount}`);
  console.log(sentCount === 1 ? "✅ Une alerte envoyée pour l'erreur détectée\n" : "❌ ÉCHEC\n");

  console.log("── Même prix détecté à nouveau : pas de re-envoi ──");
  const before = sentCount;
  await notifyWatchers("PC portable gamer", [
    { name: "PC portable gamer", seller: "Cdiscount", price: 350, url: "https://x/2" },
  ]);
  console.log(`  emails envoyés (delta) : ${sentCount - before}`);
  console.log(sentCount === before ? "✅ Pas de doublon pour le même prix\n" : "❌ ÉCHEC\n");

  console.log("── Nouveau prix (encore plus bas) : nouvel envoi ──");
  const before2 = sentCount;
  await notifyWatchers("PC portable gamer", [
    { name: "PC portable gamer", seller: "Cdiscount", price: 300, url: "https://x/3" },
  ]);
  console.log(`  emails envoyés (delta) : ${sentCount - before2}`);
  console.log(sentCount === before2 + 1 ? "✅ Nouvel envoi pour un nouveau prix\n" : "❌ ÉCHEC\n");
  console.log(`  destinataire : ${lastBody.to}`);
  console.log(lastBody.to === "watcher@test.com" ? "✅ Email destiné au bon membre\n" : "❌ ÉCHEC\n");

  console.log("── Produit sans aucun watcher : aucun envoi, pas d'erreur ──");
  const before3 = sentCount;
  await notifyWatchers("Produit jamais suivi", [
    { name: "Produit jamais suivi", seller: "Amazon", price: 10, url: "https://x/4" },
  ]);
  console.log(sentCount === before3 ? "✅ Aucun envoi sans watcher\n" : "❌ ÉCHEC\n");

  console.log("Tests terminés.");
}

main();
