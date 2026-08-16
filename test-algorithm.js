// Test de l'algorithme sans dépendre de SerpApi : on simule un scan.
const { analyzeOffers } = require("./src/algorithm");
const { insertSnapshots } = require("./src/db");

console.log("── Test 1 : détection par comparaison entre pairs (1er scan, pas d'historique) ──");
const batch1 = [
  { name: "Casque Gaming XYZ", price: 449, seller: "Fnac", url: "https://fnac.example/1" },
  { name: "Casque Gaming XYZ", price: 439, seller: "Boulanger", url: "https://boulanger.example/1" },
  { name: "Casque Gaming XYZ", price: 44.9, seller: "Cdiscount Marketplace", url: "https://cdiscount.example/1" },
  { name: "Casque Gaming XYZ", price: 459, seller: "Amazon", url: "https://amazon.example/1" },
];
const result1 = analyzeOffers(batch1);
result1.forEach((o) =>
  console.log(`  ${o.seller.padEnd(22)} ${String(o.price).padStart(7)} €  →  ${o.verdict.toUpperCase().padEnd(7)} (score ${o.score}, réf ${o.refPrice}€, -${o.pct}%)`)
);

const okDetected = result1.find((o) => o.seller === "Cdiscount Marketplace").verdict === "erreur";
console.log(okDetected ? "  ✅ La virgule décalée est bien détectée comme ERREUR\n" : "  ❌ ÉCHEC : non détectée\n");

// On enregistre ce scan pour construire un historique
insertSnapshots("casque gaming xyz", "hightech", batch1);

console.log("── Test 2 : détection par historique (le produit a déjà un passif de prix) ──");
// On simule plusieurs jours de scans à un prix stable ~450€
for (let i = 0; i < 5; i++) {
  insertSnapshots("casque gaming xyz", "hightech", [
    { name: "Casque Gaming XYZ", price: 445 + Math.random() * 10, seller: "Fnac" },
  ]);
}
const batch2 = [{ name: "Casque Gaming XYZ", price: 89, seller: "Boutique Inconnue" }];
const result2 = analyzeOffers(batch2);
console.log(`  Prix vu : ${batch2[0].price}€, référence historique calculée : ${result2[0].refPrice}€`);
console.log(`  Verdict : ${result2[0].verdict.toUpperCase()} (-${result2[0].pct}%, score ${result2[0].score})`);
console.log(result2[0].verdict === "erreur" ? "  ✅ Détection par historique fonctionnelle\n" : "  ❌ ÉCHEC\n");

console.log("── Test 3 : prix normal, ne doit PAS être flaggé ──");
const batch3 = [
  { name: "Clavier Mécanique ABC", price: 79, seller: "Amazon" },
  { name: "Clavier Mécanique ABC", price: 82, seller: "Fnac" },
  { name: "Clavier Mécanique ABC", price: 75, seller: "LDLC" },
];
const result3 = analyzeOffers(batch3);
result3.forEach((o) => console.log(`  ${o.seller.padEnd(10)} ${o.price}€ → ${o.verdict}`));
console.log(result3.every((o) => o.verdict === "normal") ? "  ✅ Pas de faux positif\n" : "  ❌ ÉCHEC : faux positif détecté\n");

console.log("── Test 4 : badge 'prix le plus bas jamais vu' ──");
for (let i = 0; i < 5; i++) {
  insertSnapshots("clavier mecanique abc", "hightech", [
    { name: "Clavier Mécanique ABC", price: 78 + Math.random() * 6, seller: "Fnac" },
  ]);
}
const batch4 = [{ name: "Clavier Mécanique ABC", price: 65, seller: "Amazon" }];
const result4 = analyzeOffers(batch4);
console.log(`  Prix vu : 65€ (historique ~78-84€) → allTimeLow=${result4[0].allTimeLow} (attendu : true)`);
console.log(result4[0].allTimeLow ? "  ✅ Badge correctement déclenché\n" : "  ❌ ÉCHEC\n");

const batch5 = [{ name: "Clavier Mécanique ABC", price: 90, seller: "Amazon" }]; // plus cher que l'historique
const result5 = analyzeOffers(batch5);
console.log(`  Prix vu : 90€ (plus cher que l'historique) → allTimeLow=${result5[0].allTimeLow} (attendu : false)`);
console.log(!result5[0].allTimeLow ? "  ✅ Pas de faux badge quand le prix est plus haut\n" : "  ❌ ÉCHEC\n");

console.log("Tests terminés.");
