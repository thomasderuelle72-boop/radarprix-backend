// merchants.js — Métadonnées simples sur les marchands français suivis.
// Sert à distinguer un marchand établi d'une marketplace ou d'un vendeur
// inconnu, afin de pondérer la confiance d'une anomalie de prix.
const MERCHANTS = [
  { key: "amazon", aliases: ["amazon", "amazon.fr"], type: "retailer_marketplace", trust: 90, risk: 25 },
  { key: "fnac", aliases: ["fnac", "fnac.com"], type: "retailer_marketplace", trust: 85, risk: 30 },
  { key: "darty", aliases: ["darty"], type: "retailer_marketplace", trust: 85, risk: 30 },
  { key: "boulanger", aliases: ["boulanger"], type: "retailer", trust: 88, risk: 20 },
  { key: "cdiscount", aliases: ["cdiscount"], type: "retailer_marketplace", trust: 78, risk: 40 },
  { key: "ldlc", aliases: ["ldlc"], type: "retailer", trust: 88, risk: 20 },
  { key: "materiel.net", aliases: ["materiel.net", "materiel net", "materielnet"], type: "retailer", trust: 86, risk: 20 },
  { key: "rakuten", aliases: ["rakuten", "priceminister"], type: "marketplace", trust: 65, risk: 60 },
  { key: "leclerc", aliases: ["leclerc", "e.leclerc", "e leclerc"], type: "retailer_marketplace", trust: 78, risk: 40 },
  { key: "carrefour", aliases: ["carrefour"], type: "retailer_marketplace", trust: 78, risk: 40 },
  { key: "rueducommerce", aliases: ["rue du commerce", "rueducommerce"], type: "retailer_marketplace", trust: 72, risk: 45 },
  { key: "micromania", aliases: ["micromania", "zing"], type: "retailer", trust: 80, risk: 30 },
];

function normalizeMerchantName(name) {
  return (name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}

function merchantProfile(seller) {
  const normalized = normalizeMerchantName(seller);
  if (!normalized) return { key: null, type: "unknown", trust: 35, risk: 75, known: false };

  const profile = MERCHANTS.find((m) => m.aliases.some((alias) => normalized.includes(normalizeMerchantName(alias))));
  if (!profile) return { key: null, type: "unknown", trust: 40, risk: 70, known: false };
  return { ...profile, known: true };
}

module.exports = { MERCHANTS, normalizeMerchantName, merchantProfile };
