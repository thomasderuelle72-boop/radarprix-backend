const { pickBestStore } = require("./src/serpapi");

console.log("── Test : correspondance par nom de vendeur ──");
const stores1 = [
  { name: "Cdiscount Marketplace - Vendeur X", link: "https://cdiscount.example/produit/123" },
  { name: "Amazon.fr", link: "https://amazon.example/produit/456" },
  { name: "Fnac", link: "https://fnac.example/produit/789" },
];
const r1 = pickBestStore(stores1, "Cdiscount Marketplace", 44.9);
console.log("  Résultat :", r1);
console.log(r1 === "https://cdiscount.example/produit/123" ? "  ✅ Bon vendeur retrouvé\n" : "  ❌ ÉCHEC\n");

console.log("── Test : pas de correspondance de nom, repli sur le prix le plus proche ──");
const stores2 = [
  { name: "Boutique Inconnue A", link: "https://a.example", extracted_price: 30 },
  { name: "Boutique Inconnue B", link: "https://b.example", extracted_price: 89 },
  { name: "Boutique Inconnue C", link: "https://c.example", extracted_price: 450 },
];
const r2 = pickBestStore(stores2, "Vendeur Introuvable", 92);
console.log("  Résultat :", r2, "(attendu : b.example, prix le plus proche de 92)");
console.log(r2 === "https://b.example" ? "  ✅ Repli sur le prix fonctionne\n" : "  ❌ ÉCHEC\n");

console.log("── Test : aucun store ──");
const r3 = pickBestStore([], "X", 10);
console.log(r3 === null ? "  ✅ Retourne null proprement\n" : "  ❌ ÉCHEC\n");

console.log("Tests terminés.");
