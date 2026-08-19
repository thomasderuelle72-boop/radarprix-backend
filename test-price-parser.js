const assert = require("node:assert/strict");
const { parsePrice } = require("./src/serpapi");

console.log("── Test : parsing des prix français et internationaux ──");
const cases = [
  ["699,99 €", 699.99],
  ["1 299,00 €", 1299],
  ["1.299,00 €", 1299],
  ["1,299.00 €", 1299],
  [1299, 1299],
  [null, 0],
];

for (const [raw, expected] of cases) {
  const actual = parsePrice(raw);
  console.log(`  ${String(raw).padEnd(12)} → ${actual}`);
  assert.equal(actual, expected);
}

console.log("✅ Tous les formats de prix sont correctement parsés");
