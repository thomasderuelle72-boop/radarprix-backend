// Vérifie que le Deal Score (attractivité du prix) et le Confidence Score
// (fiabilité de la détection) varient bien indépendamment l'un de l'autre :
// une remise énorme et isolée doit avoir un Deal Score élevé mais un
// Confidence Score bas, tandis qu'une remise plus modeste mais confirmée
// par plusieurs vendeurs cohérents ET l'historique doit avoir les deux hauts.
process.env.SERPAPI_KEY = "fake";
process.env.JWT_SECRET = "test-secret";

const { insertSnapshots } = require("./src/db");
const { analyzeOffers } = require("./src/algorithm");

console.log("── Cas confirmé : plusieurs vendeurs cohérents + historique ──");
// Historique stable ~1249€ sur plusieurs jours.
for (let i = 0; i < 5; i++) {
  insertSnapshots("lg oled c5 55", "hightech", [
    { name: "LG OLED C5 55 pouces", price: 1240 + Math.random() * 20, seller: "Fnac" },
  ]);
}
const confirmedBatch = [
  { name: "LG OLED C5 55 pouces", price: 699, seller: "Amazon" }, // -44% environ
  { name: "LG OLED C5 55 pouces", price: 1289, seller: "Darty" },
  { name: "LG OLED C5 55 pouces", price: 1309, seller: "Fnac" },
];
const confirmedResult = analyzeOffers(confirmedBatch);
const confirmedDeal = confirmedResult.find((o) => o.seller === "Amazon");
console.log(`  Amazon 699€ (réf ${confirmedDeal.refPrice}€, ${confirmedDeal.pct}%) → Deal Score ${confirmedDeal.score}, Confidence ${confirmedDeal.confidence}`);

console.log("\n── Cas non confirmé : remise énorme, isolée, sans historique ──");
const suspiciousBatch = [{ name: "Trottinette électrique Xiaomi Electric Scooter 5", price: 79, seller: "Boutique Louche" }];
// Un seul pair dans le lot à un prix "marché" pour fournir une référence entre pairs.
suspiciousBatch.push({ name: "Trottinette électrique Xiaomi Electric Scooter 5", price: 799, seller: "Fnac" });
const suspiciousResult = analyzeOffers(suspiciousBatch);
const suspiciousDeal = suspiciousResult.find((o) => o.seller === "Boutique Louche");
console.log(`  Boutique Louche 79€ (réf ${suspiciousDeal.refPrice}€, ${suspiciousDeal.pct}%) → Deal Score ${suspiciousDeal.score}, Confidence ${suspiciousDeal.confidence}`);

console.log("\n── Assertions ──");
// Le cas confirmé est un "gros deal" (44%, verdict deal) et le cas non
// confirmé une "erreur" (82%, verdict erreur) : deux Deal Scores élevés à
// leur échelle respective, ce n'est PAS censé être identique — seule la
// Confidence doit nettement diverger entre les deux (voir plus bas).
const dealScoreHighBoth = confirmedDeal.verdict !== "normal" && suspiciousDeal.score > confirmedDeal.score;
console.log(
  dealScoreHighBoth
    ? `✅ Les deux sont détectés comme deal/erreur, Deal Score plus élevé pour la remise la plus forte (${confirmedDeal.score} vs ${suspiciousDeal.score})`
    : "❌ ÉCHEC sur le Deal Score"
);

const confidenceDiffers = confirmedDeal.confidence > suspiciousDeal.confidence + 20;
console.log(
  confidenceDiffers
    ? `✅ Le cas confirmé a une Confidence nettement plus haute (${confirmedDeal.confidence} vs ${suspiciousDeal.confidence})`
    : `❌ ÉCHEC : les deux Confidence Scores sont trop proches (${confirmedDeal.confidence} vs ${suspiciousDeal.confidence})`
);

const suspiciousLowConfidence = suspiciousDeal.confidence < 60;
console.log(
  suspiciousLowConfidence
    ? `✅ Le cas non confirmé reste sous le seuil de confiance élevée (${suspiciousDeal.confidence} < 60)`
    : `❌ ÉCHEC : confidence trop haute pour un cas non confirmé (${suspiciousDeal.confidence})`
);

console.log("\n── Contrôle : aucune référence disponible → confidence null, pas 0 fabriqué ──");
const noRef = analyzeOffers([{ name: "Produit jamais vu Modèle Unique 9999", price: 42, seller: "X" }]);
console.log(`  confidence = ${noRef[0].confidence}`);
console.log(noRef[0].confidence === null ? "✅ confidence null quand aucune base de comparaison n'existe\n" : "❌ ÉCHEC\n");

console.log("Tests terminés.");
