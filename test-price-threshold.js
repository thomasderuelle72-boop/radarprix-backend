// Vérifie l'alerte sur seuil de prix : un membre qui fixe "préviens-moi
// sous X €" est notifié dès que le prix passe sous X, même quand
// l'algorithme ne crie pas "erreur de prix" — et un membre sans seuil
// n'est PAS notifié dans ce cas.
process.env.SERPAPI_KEY = "fake";
process.env.JWT_SECRET = "test-secret";
process.env.RESEND_API_KEY = "fake-resend-key";

const { createUser, addToWatchlist, getWatchlist, insertSnapshots } = require("./src/db");
const { notifyWatchers } = require("./src/scanBatch");

let envois = [];
global.fetch = async (url, opts) => {
  envois.push(JSON.parse(opts.body));
  return { ok: true, json: async () => ({}) };
};

async function main() {
  const avecSeuil = createUser("seuil@test.com", "h");
  const sansSeuil = createUser("sans@test.com", "h");

  // Prix habituel autour de 800 € : une offre à 700 € est un vrai bon prix
  // mais reste loin du seuil "erreur" (-60%), donc l'algorithme la classera
  // "normal" ou "deal" — exactement le cas que le seuil doit couvrir.
  insertSnapshots("iphone 15 128 go", "hightech", [
    { name: "iPhone 15 128 Go", seller: "Fnac", price: 799 },
    { name: "iPhone 15 128 Go", seller: "Amazon", price: 809 },
    { name: "iPhone 15 128 Go", seller: "Darty", price: 795 },
  ]);

  addToWatchlist(avecSeuil.id, "iPhone 15 128 Go", "hightech", 720);
  addToWatchlist(sansSeuil.id, "iPhone 15 128 Go", "hightech");

  console.log("── Le seuil est bien enregistré et relu ──");
  const liste = getWatchlist(avecSeuil.id);
  console.log(`  target_price = ${liste[0].target_price}`);
  console.log(liste[0].target_price === 720 ? "✅ Seuil persisté\n" : "❌ ÉCHEC\n");

  console.log("── Prix sous le seuil : seul le membre avec seuil est prévenu ──");
  envois = [];
  await notifyWatchers("iPhone 15 128 Go", [
    { name: "iPhone 15 128 Go", seller: "Cdiscount", price: 699, url: "https://x/1" },
    { name: "iPhone 15 128 Go", seller: "Fnac", price: 799 },
    { name: "iPhone 15 128 Go", seller: "Amazon", price: 809 },
  ]);
  console.log(`  ${envois.length} email(s) → ${envois.map((e) => e.to).join(", ") || "aucun"}`);
  const bonDestinataire = envois.length === 1 && envois[0].to === "seuil@test.com";
  console.log(bonDestinataire ? "✅ Seul le membre ayant fixé un seuil est notifié\n" : "❌ ÉCHEC\n");

  console.log("── L'email parle bien de prix cible, pas d'erreur de prix ──");
  const sujet = envois[0]?.subject || "";
  console.log(`  sujet : ${sujet}`);
  console.log(
    sujet.includes("passé à") && !sujet.includes("Erreur")
      ? "✅ Message adapté au motif 'seuil'\n"
      : "❌ ÉCHEC\n"
  );

  console.log("── Même prix au scan suivant : pas de relance ──");
  const avant = envois.length;
  await notifyWatchers("iPhone 15 128 Go", [
    { name: "iPhone 15 128 Go", seller: "Cdiscount", price: 699, url: "https://x/1" },
    { name: "iPhone 15 128 Go", seller: "Fnac", price: 799 },
  ]);
  console.log(envois.length === avant ? "✅ Pas de doublon pour le même prix\n" : "❌ ÉCHEC\n");

  console.log("── Prix au-dessus du seuil : personne n'est notifié ──");
  envois = [];
  await notifyWatchers("iPhone 15 128 Go", [
    { name: "iPhone 15 128 Go", seller: "Fnac", price: 780 },
    { name: "iPhone 15 128 Go", seller: "Amazon", price: 790 },
  ]);
  console.log(envois.length === 0 ? "✅ Aucun envoi tant que le seuil n'est pas franchi\n" : "❌ ÉCHEC\n");

  console.log("── Re-suivre le produit met à jour le seuil au lieu d'être ignoré ──");
  addToWatchlist(avecSeuil.id, "iPhone 15 128 Go", "hightech", 650);
  const maj = getWatchlist(avecSeuil.id);
  console.log(`  nouveau target_price = ${maj[0].target_price}, ${maj.length} ligne(s)`);
  console.log(maj.length === 1 && maj[0].target_price === 650 ? "✅ Seuil mis à jour, pas de doublon\n" : "❌ ÉCHEC\n");

  console.log("Tests terminés.");
}

main();
