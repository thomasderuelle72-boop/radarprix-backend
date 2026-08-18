// Simule un cron qui a déjà tourné : on insère des snapshots pour PLUSIEURS
// produits différents, dans différentes catégories, puis on vérifie que
// /api/deals les agrège, filtre et pagine correctement — sans réseau.
process.env.SERPAPI_KEY = "fake";
process.env.JWT_SECRET = "test-secret";

const { insertSnapshots } = require("./src/db");

console.log("── Simulation d'un catalogue déjà scanné par le cron ──");

// Produit 1 : PS5 Slim (gaming) — une vraie erreur de prix dedans
insertSnapshots("playstation 5 slim", "gaming", [
  { name: "PlayStation 5 Slim", price: 479, seller: "Fnac" },
  { name: "PlayStation 5 Slim", price: 469, seller: "Amazon" },
  { name: "PlayStation 5 Slim", price: 89, seller: "Boutique Louche" }, // erreur
]);

// Produit 2 : iPhone 15 (hightech) — un gros deal
insertSnapshots("iphone 15 128 go", "hightech", [
  { name: "iPhone 15 128 Go", price: 799, seller: "Fnac" },
  { name: "iPhone 15 128 Go", price: 789, seller: "Amazon" },
  { name: "iPhone 15 128 Go", price: 420, seller: "Cdiscount" }, // deal
]);

// Produit 3 : Aspirateur (maison) — rien d'anormal, ne doit PAS apparaître
insertSnapshots("aspirateur robot roborock", "maison", [
  { name: "Aspirateur robot Roborock", price: 399, seller: "Fnac" },
  { name: "Aspirateur robot Roborock", price: 409, seller: "Amazon" },
  { name: "Aspirateur robot Roborock", price: 389, seller: "Boulanger" },
]);

// Produit 4 : PC portable gamer (gaming) — une erreur de prix dedans, pour
// tester la recherche par mot-clé "pc" (voir tests plus bas).
insertSnapshots("pc portable gamer rtx 4060", "gaming", [
  { name: "PC portable gamer RTX 4060", price: 1299, seller: "LDLC" },
  { name: "PC portable gamer RTX 4060", price: 1279, seller: "Materiel.net" },
  { name: "PC portable gamer RTX 4060", price: 299, seller: "Boutique Louche" },
]);

console.log("Données simulées insérées.\n");

console.log("── Test : /api/deals sans filtre de catégorie ──");
const { latestBatchPerProduct } = require("./src/db");
const { filterRelevantOffers, analyzeOffers } = require("./src/algorithm");

function foldAccents(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Reflète fidèlement la vraie route GET /api/deals de server.js (mêmes
// étapes : query d'origine pour le filtrage de pertinence, puis filtre
// optionnel par mot-clé "q" sur les deals déjà validés individuellement).
function simulateDealsEndpoint(category, page, pageSize, q) {
  const batches = latestBatchPerProduct(category);
  const allFlagged = [];
  for (const { query, offers } of batches) {
    if (offers.length === 0) continue;
    const relevant = filterRelevantOffers(offers, query);
    const analyzed = analyzeOffers(relevant).filter((o) => o.verdict !== "normal");
    allFlagged.push(...analyzed);
  }
  const folded = foldAccents(q);
  const matching = folded ? allFlagged.filter((o) => foldAccents(o.name).includes(folded)) : allFlagged;
  matching.sort((a, b) => b.score - a.score);
  const total = matching.length;
  const start = (page - 1) * pageSize;
  return { total, hasMore: start + pageSize < total, items: matching.slice(start, start + pageSize) };
}

const all = simulateDealsEndpoint("tout", 1, 15);
console.log(`Total deals tous produits confondus : ${all.total} (attendu : 3 — PS5, iPhone et PC gamer, pas l'aspirateur)`);
all.items.forEach((i) => console.log(`  - ${i.name} (${i.price}€, ${i.verdict})`));
console.log(all.total === 3 ? "✅ Bon nombre de deals, aspirateur normal bien exclu\n" : "❌ ÉCHEC\n");

console.log("── Test : filtre par catégorie 'gaming' ──");
const gaming = simulateDealsEndpoint("gaming", 1, 15);
console.log(`Deals en gaming : ${gaming.total} (attendu : 2 — PS5 et PC gamer)`);
console.log(gaming.total === 2 ? "✅ Filtre catégorie fonctionne\n" : "❌ ÉCHEC\n");

console.log("── Test : recherche par mot-clé 'pc' (reproduit le cas signalé en prod) ──");
const pcSearch = simulateDealsEndpoint("tout", 1, 15, "pc");
console.log(`Résultats pour \"pc\" : ${pcSearch.total} (attendu : 1 — le PC gamer, jamais comparé à un autre produit)`);
console.log(
  pcSearch.total === 1 && pcSearch.items[0].name.includes("PC portable")
    ? "✅ La recherche large retrouve les deals déjà validés, sans comparaison inventée\n"
    : "❌ ÉCHEC\n"
);

console.log("── Test : recherche par mot-clé insensible aux accents ──");
const accentSearch = simulateDealsEndpoint("tout", 1, 15, "PLAYSTATION");
console.log(`Résultats pour \"PLAYSTATION\" (majuscules) : ${accentSearch.total} (attendu : 1)`);
console.log(accentSearch.total === 1 ? "✅ Recherche insensible à la casse\n" : "❌ ÉCHEC\n");

console.log("── Test : filtre par catégorie 'maison' (aucun deal attendu) ──");
const maison = simulateDealsEndpoint("maison", 1, 15);
console.log(`Deals en maison : ${maison.total} (attendu : 0)`);
console.log(maison.total === 0 ? "✅ Aucun faux positif en maison\n" : "❌ ÉCHEC\n");

console.log("── Test : pagination (pageSize=1, total=3) ──");
const p1 = simulateDealsEndpoint("tout", 1, 1);
const p2 = simulateDealsEndpoint("tout", 2, 1);
const p3 = simulateDealsEndpoint("tout", 3, 1);
console.log(`Page 1 : ${p1.items.length} item, hasMore=${p1.hasMore}`);
console.log(`Page 2 : ${p2.items.length} item, hasMore=${p2.hasMore}`);
console.log(`Page 3 : ${p3.items.length} item, hasMore=${p3.hasMore}`);
const paginationOk =
  p1.items.length === 1 && p1.hasMore === true &&
  p2.items.length === 1 && p2.hasMore === true &&
  p3.items.length === 1 && p3.hasMore === false;
console.log(paginationOk ? "✅ Pagination correcte (3 pages sans doublon)\n" : "❌ ÉCHEC\n");

console.log("Tests terminés.");
