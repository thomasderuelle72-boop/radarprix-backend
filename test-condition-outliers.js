// Vérifie deux protections contre la pollution des références de prix :
// 1) les annonces reconditionnées/d'occasion du bon produit sont écartées
//    (elles passaient le filtre de pertinence mais faussaient la référence).
// 2) un prix grossièrement aberrant dans un cluster (mauvais rapprochement
//    resté malgré le filtrage) est écarté du calcul, même sur un petit lot
//    où le rognage à 10% de trimmedMedian ne suffit pas.
const { filterRelevantOffers, isUsedOrRefurbishedTitle, stripGrossOutliers, analyzeOffers } = require("./src/algorithm");

console.log("── Annonces reconditionnées/d'occasion écartées malgré un bon match de modèle ──");
console.log("  'iPhone 15 128 Go reconditionné' :", isUsedOrRefurbishedTitle("iPhone 15 128 Go reconditionné"));
console.log("  'iPhone 15 128 Go (Grade B)' :", isUsedOrRefurbishedTitle("iPhone 15 128 Go (Grade B)"));
console.log("  'iPhone 15 128 Go neuf sous blister' :", isUsedOrRefurbishedTitle("iPhone 15 128 Go neuf sous blister"));
const cond1 = isUsedOrRefurbishedTitle("iPhone 15 128 Go reconditionné") === true;
const cond2 = isUsedOrRefurbishedTitle("iPhone 15 128 Go (Grade B)") === true;
const cond3 = isUsedOrRefurbishedTitle("iPhone 15 128 Go neuf sous blister") === false;
console.log(cond1 && cond2 && cond3 ? "✅ Détection condition correcte\n" : "❌ ÉCHEC\n");

console.log("── Lot mixte neuf/reconditionné : le reconditionné est retiré avant analyse ──");
const mixedBatch = [
  { name: "iPhone 15 128 Go", price: 799, seller: "Fnac" },
  { name: "iPhone 15 128 Go", price: 789, seller: "Amazon" },
  { name: "iPhone 15 128 Go", price: 809, seller: "Boulanger" },
  { name: "iPhone 15 128 Go reconditionné Grade A", price: 480, seller: "Backmarket" },
  { name: "iPhone 15 128 Go reconditionné Grade B", price: 420, seller: "Recommerce" },
];
const filtered = filterRelevantOffers(mixedBatch, "iPhone 15 128 Go");
console.log(`  ${mixedBatch.length} offres avant, ${filtered.length} après filtrage :`);
filtered.forEach((o) => console.log(`    - ${o.name} (${o.price}€)`));
const onlyNew = filtered.length === 3 && filtered.every((o) => o.price > 700);
console.log(onlyNew ? "✅ Seules les offres neuves restent\n" : "❌ ÉCHEC : du reconditionné est encore présent\n");

console.log("── Analyse sur ce lot filtré : pas de fausse alerte causée par le reconditionné ──");
const analyzed = analyzeOffers(filtered);
analyzed.forEach((o) => console.log(`  ${o.seller.padEnd(10)} ${o.price}€ → ${o.verdict} (réf ${o.refPrice}€)`));
console.log(analyzed.every((o) => o.verdict === "normal") ? "✅ Aucune fausse alerte\n" : "❌ ÉCHEC\n");

console.log("── stripGrossOutliers : un intrus à 15€ au milieu de téléphones à ~700€ est écarté ──");
const withIntruder = [699, 719, 705, 15, 689];
const cleaned = stripGrossOutliers(withIntruder);
console.log(`  avant : [${withIntruder.join(", ")}] → après : [${cleaned.join(", ")}]`);
console.log(!cleaned.includes(15) && cleaned.length === 4 ? "✅ Intrus écarté, les vrais prix conservés\n" : "❌ ÉCHEC\n");

console.log("── stripGrossOutliers : lot cohérent inchangé (rien à écarter) ──");
const coherent = [699, 719, 705, 689, 710];
const stillSame = stripGrossOutliers(coherent);
console.log(stillSame.length === coherent.length ? "✅ Lot cohérent laissé intact\n" : "❌ ÉCHEC\n");

console.log("── stripGrossOutliers : garde-fou, ne descend jamais sous la moitié du lot ──");
// [10, 900, 15, 850] est pile à la limite (2 gardés sur 4, le seuil minimal
// autorisé) : le filtre retient légitimement le sous-groupe le plus cohérent
// (850/900) plutôt que de tout jeter — comportement voulu, pas un repli.
const borderline = [10, 900, 15, 850];
const keptSubset = stripGrossOutliers(borderline);
console.log(`  [${borderline.join(", ")}] → [${keptSubset.join(", ")}]`);
console.log(
  keptSubset.length === 2 && keptSubset.every((p) => p >= 800)
    ? "✅ Garde le sous-groupe cohérent, jamais moins de la moitié\n"
    : "❌ ÉCHEC\n"
);

console.log("── stripGrossOutliers : repli sur la liste d'origine si trop peu survivrait ──");
// Médiane à 1000 (valeur centrale) ; sa fenêtre [250, 4000] n'y retient
// qu'elle-même — 1 survivant sur 3, sous le seuil minimal (2) : repli.
const tooFewSurvive = [1, 1000, 1000000];
const fallback = stripGrossOutliers(tooFewSurvive);
console.log(`  [${tooFewSurvive.join(", ")}] → [${fallback.join(", ")}]`);
console.log(fallback.length === tooFewSurvive.length ? "✅ Repli sur la liste d'origine (pas de sur-filtrage)\n" : "❌ ÉCHEC\n");

console.log("Tests terminés.");
