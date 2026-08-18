// Vérifie que l'historique de prix (priceHistoryFor, utilisé par
// analyzeOffers) est bien partagé entre deux formulations différentes du
// même produit — grâce à product_key (productKey.js) — plutôt que par
// titre exact comme avant.
process.env.SERPAPI_KEY = "fake";
process.env.JWT_SECRET = "test-secret";

const { productKey } = require("./src/productKey.js");
const { insertSnapshots } = require("./src/db");
const { analyzeOffers } = require("./src/algorithm");

console.log("── productKey() normalise across formulations ──");
const keyA = productKey("Apple AirPods Pro 2 USB-C");
const keyB = productKey("AirPods Pro 2 USB-C Apple"); // même mots, ordre différent
console.log(`  "Apple AirPods Pro 2 USB-C" -> ${keyA}`);
console.log(`  "AirPods Pro 2 USB-C Apple" -> ${keyB}`);
console.log(keyA === keyB ? "✅ Même clé malgré l'ordre des mots différent\n" : "❌ ÉCHEC\n");

console.log("── Historique partagé entre deux formulations du même produit ──");
// 5 jours d'historique enregistrés sous UN titre...
for (let i = 0; i < 5; i++) {
  insertSnapshots("airpods pro 2 usb-c", "hightech", [
    { name: "Apple AirPods Pro 2 USB-C", price: 245 + Math.random() * 10, seller: "Fnac" },
  ]);
}
// ...un nouveau scan arrive avec un titre DIFFÉREMMENT FORMULÉ pour le même produit.
const batch = [{ name: "AirPods Pro 2 USB-C Apple", price: 79, seller: "Boutique Louche" }];
const result = analyzeOffers(batch);
console.log(`  Prix vu : 79€, référence historique retrouvée : ${result[0].refPrice}€`);
console.log(
  result[0].verdict === "erreur" && result[0].refPrice > 200
    ? "✅ L'historique du produit (formulé différemment) a bien été retrouvé et l'erreur détectée\n"
    : "❌ ÉCHEC : historique non retrouvé malgré la formulation différente\n"
);

console.log("── Contrôle : un produit vraiment différent ne doit PAS hériter de cet historique ──");
const different = [{ name: "Samsung Galaxy Buds 3", price: 79, seller: "Amazon" }];
const differentResult = analyzeOffers(different);
console.log(`  "Samsung Galaxy Buds 3" à 79€ → refPrice = ${differentResult[0].refPrice ?? "—"}`);
console.log(
  differentResult[0].refPrice === null
    ? "✅ Aucun historique inventé pour un produit sans rapport\n"
    : "❌ ÉCHEC : a hérité à tort de l'historique d'un autre produit\n"
);

console.log("Tests terminés.");
