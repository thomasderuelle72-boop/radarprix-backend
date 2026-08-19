// Reproduit le bug signalé en production : une recherche large ("PC portable
// Dell") fait remonter plusieurs modèles Dell différents dans un même lot.
// Avant la correction, analyzeOffers calculait UNE médiane pour tout le lot
// mélangé : chaque modèle héritait alors du même "prix barré" (795€), qui ne
// correspondait à aucun d'entre eux, et se faisait flagger ERREUR à tort.
process.env.SERPAPI_KEY = "fake";
process.env.JWT_SECRET = "test-secret";
process.env.DB_PATH = require("node:path").join(require("node:os").tmpdir(), `radarprix-test-cluster-regression-${process.pid}.sqlite`);

const { analyzeOffers } = require("./src/algorithm");

console.log("── Reproduction : plusieurs modèles Dell différents dans un même lot ──");
const offers = [
  { name: "Dell Latitude E7470", price: 204, seller: "Fnac" },
  { name: "14\" Dell Latitude 7480", price: 204, seller: "Fnac" },
  { name: "Dell 7010 - core i5-3470 - 8go - 500go -windows 10", price: 298, seller: "Darty" },
  { name: "PC Dell Optiplex 9010 DT", price: 795, seller: "Boulanger" },
];
const results = analyzeOffers(offers);
results.forEach((o) => console.log(`  ${o.name.padEnd(45)} ${String(o.price).padStart(4)}€ → ${o.verdict.toUpperCase().padEnd(7)} (réf ${o.refPrice ?? "—"}€)`));

// Le vrai bug signalé : plusieurs produits différents héritaient d'une seule
// médiane calculée sur tout le lot mélangé (ex: 795€ partout). Ici, aucun de
// ces modèles n'a de pair dans le lot ni d'historique : la seule référence
// correcte est l'absence de référence (null) — jamais une valeur partagée.
const numericRefs = results.map((o) => o.refPrice).filter((r) => r !== null);
const sharedFakeRef = numericRefs.length > 1 && numericRefs.every((r) => r === numericRefs[0]);
console.log(
  !sharedFakeRef
    ? "✅ Aucune médiane partagée entre ces produits différents (référence absente, comme attendu)\n"
    : "❌ ÉCHEC : ces produits différents partagent encore une même référence fabriquée\n"
);

const noFalseErreur = results.every((o) => o.verdict !== "erreur");
console.log(
  noFalseErreur
    ? "✅ Aucun modèle sans pair comparable n'est flaggé ERREUR à tort\n"
    : "❌ ÉCHEC : un modèle isolé est flaggé ERREUR sans base de comparaison valide\n"
);

console.log("── Contrôle : de vraies offres du même produit se comparent toujours entre elles ──");
const samePs5 = [
  { name: "PlayStation 5 Slim", price: 479, seller: "Fnac" },
  { name: "PlayStation 5 Slim", price: 469, seller: "Amazon" },
  { name: "PlayStation 5 Slim", price: 89, seller: "Boutique Louche" },
];
const ps5Results = analyzeOffers(samePs5);
ps5Results.forEach((o) => console.log(`  ${o.seller.padEnd(16)} ${o.price}€ → ${o.verdict.toUpperCase()} (réf ${o.refPrice}€)`));
const ps5RefsOk = ps5Results.every((o) => o.refPrice === ps5Results[0].refPrice);
const ps5ErreurDetectee = ["erreur", "erreur_verifiee"].includes(ps5Results.find((o) => o.seller === "Boutique Louche").verdict);
console.log(
  ps5RefsOk && ps5ErreurDetectee
    ? "✅ Toujours une référence partagée + détection correcte pour un vrai groupe de pairs\n"
    : "❌ ÉCHEC : régression sur la comparaison entre pairs d'un même produit\n"
);

console.log("Tests terminés.");
