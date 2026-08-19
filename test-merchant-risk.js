process.env.SERPAPI_KEY = "fake";
process.env.JWT_SECRET = "test-secret";
process.env.DB_PATH = require("node:path").join(require("node:os").tmpdir(), `radarprix-merchant-risk-${process.pid}.sqlite`);

const assert = require("node:assert/strict");
const { merchantProfile } = require("./src/merchants");
const { analyzeOffers } = require("./src/algorithm");

console.log("── Profil marchand : vendeur établi vs inconnu ──");
const fnac = merchantProfile("Fnac Marketplace");
const unknown = merchantProfile("Boutique Louche");
assert.equal(fnac.known, true);
assert.equal(unknown.known, false);
assert.equal(fnac.risk < unknown.risk, true);
console.log(`✅ Fnac risk=${fnac.risk}, inconnu risk=${unknown.risk}`);

console.log("── Score : une erreur chez marchand connu est plus fiable qu'une offre inconnue ──");
const baseOffers = [
  { name: "Console PlayStation 5 Slim", price: 479, seller: "Amazon" },
  { name: "Console PlayStation 5 Slim", price: 469, seller: "Boulanger" },
  { name: "Console PlayStation 5 Slim", price: 489, seller: "Darty" },
];
const trusted = analyzeOffers([...baseOffers, { name: "Console PlayStation 5 Slim", price: 99, seller: "Fnac" }]).find((o) => o.seller === "Fnac");
const risky = analyzeOffers([...baseOffers, { name: "Console PlayStation 5 Slim", price: 99, seller: "Boutique Louche" }]).find((o) => o.seller === "Boutique Louche");
console.log(`  Fnac → ${trusted.verdict}, confidence=${trusted.confidence}, risk=${trusted.merchantRisk}`);
console.log(`  Inconnu → ${risky.verdict}, confidence=${risky.confidence}, risk=${risky.merchantRisk}`);
assert.equal(trusted.verdict, "erreur_verifiee");
assert.equal(risky.verdict, "erreur");
assert.equal(trusted.confidence > risky.confidence, true);
assert.equal(trusted.merchantRisk < risky.merchantRisk, true);

console.log("✅ Risque marchand intégré au verdict et à la confiance");
