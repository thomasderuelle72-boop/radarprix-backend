const { analyzeOffers, filterRelevantOffers, isAccessoryTitle, titleMatchesQuery } = require("./src/algorithm");

console.log("── Reproduction du bug signalé : accessoires mélangés aux vrais produits ──");
const pollutedBatch = [
  { name: "PlayStation 5 Slim 1To", price: 479, seller: "Fnac" },
  { name: "PlayStation 5 Slim 1To", price: 469, seller: "Amazon" },
  { name: "PlayStation 5 Slim 1To", price: 489, seller: "Cdiscount" },
  { name: "Coque de protection pour PlayStation 5 Slim", price: 14.9, seller: "Amazon" },
  { name: "Housse de transport pour PS5", price: 22, seller: "Cdiscount" },
  { name: "Manette pour PS5 sans fil compatible", price: 28, seller: "AliExpress" },
  { name: "Support mural pour PlayStation 5", price: 19.9, seller: "Amazon" },
  { name: "Chargeur pour manette PS5", price: 12, seller: "Cdiscount" },
];

console.log("\nAvant filtrage :", pollutedBatch.length, "offres");
const filtered = filterRelevantOffers(pollutedBatch, "PlayStation 5 Slim");
console.log("Après filtrage :", filtered.length, "offres restantes :");
filtered.forEach((o) => console.log(`  - ${o.name} (${o.price}€)`));

const accessoriesRemoved = filtered.length === 3 && filtered.every((o) => o.price > 400);
console.log(accessoriesRemoved ? "\n✅ Les accessoires sont bien écartés, seuls les vrais PS5 restent" : "\n❌ ÉCHEC : des accessoires sont encore présents");

console.log("\n── Vérification que l'analyse sur le lot filtré ne détecte plus de fausses erreurs ──");
const analyzed = analyzeOffers(filtered);
analyzed.forEach((o) => console.log(`  ${o.seller.padEnd(10)} ${o.price}€ → ${o.verdict} (réf ${o.refPrice}€)`));
const noFalsePositive = analyzed.every((o) => o.verdict === "normal");
console.log(noFalsePositive ? "✅ Plus aucune fausse alerte sur les vrais produits\n" : "❌ ÉCHEC : encore de fausses alertes\n");

console.log("── Test titleMatchesQuery isolé ──");
console.log("  'PS5 Slim' vs requête 'PlayStation 5 Slim' :", titleMatchesQuery("PS5 Slim édition limitée", "PlayStation 5 Slim"));
console.log("  'iPhone 15 coque' vs requête 'PlayStation 5' :", titleMatchesQuery("Coque iPhone 15", "PlayStation 5 Slim"));

console.log("\n── Test du bug corrigé : confusion entre modèles différents ──");
const wrongModel1 = titleMatchesQuery("iPhone 11 64 Go reconditionné", "iPhone 15 128 Go");
console.log(`  iPhone 11 vs recherche "iPhone 15 128 Go" : ${wrongModel1} (attendu : false)`);
console.log(!wrongModel1 ? "  ✅ Modèle différent bien rejeté\n" : "  ❌ ÉCHEC : confusion de modèle non détectée\n");

const wrongStorage = titleMatchesQuery("iPhone 15 256 Go", "iPhone 15 128 Go");
console.log(`  iPhone 15 256Go vs recherche "iPhone 15 128 Go" : ${wrongStorage} (attendu : false, capacité différente)`);
console.log(!wrongStorage ? "  ✅ Capacité différente bien rejetée\n" : "  ❌ ÉCHEC\n");

const rightMatch = titleMatchesQuery("Apple iPhone 15 (128 Go) Noir", "iPhone 15 128 Go");
console.log(`  "Apple iPhone 15 (128 Go) Noir" vs recherche "iPhone 15 128 Go" : ${rightMatch} (attendu : true)`);
console.log(rightMatch ? "  ✅ Même produit, formulation différente, bien accepté\n" : "  ❌ ÉCHEC\n");

const wrongGpu = titleMatchesQuery("Carte graphique RTX 4070", "Carte graphique RTX 4060");
console.log(`  RTX 4070 vs recherche "RTX 4060" : ${wrongGpu} (attendu : false)`);
console.log(!wrongGpu ? "  ✅ Modèle de carte graphique différent bien rejeté\n" : "  ❌ ÉCHEC\n");

console.log("Tests terminés.");
