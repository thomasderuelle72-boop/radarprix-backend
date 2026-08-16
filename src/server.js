// server.js — API RadarPrix. Ne parle jamais directement au navigateur
// des visiteurs à SerpApi : la clé API reste ici, côté serveur, secrète.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { fetchShoppingResults } = require("./serpapi");
const { analyzeOffers } = require("./algorithm");
const { insertSnapshots, latestSnapshots } = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Watchlist par défaut, utilisée par les onglets du site (deals/erreurs/gratuit).
const WATCHLIST = {
  hightech: ["carte graphique promo", "smartphone promo", "casque audio promo"],
  gaming: ["PC portable gamer promo", "PC gamer RTX promo"],
  maison: ["aspirateur robot promo", "électroménager promo"],
};

/** Lance un scan réel (SerpApi) pour une requête, l'analyse, le stocke. */
async function scanQuery(query, category = "tout") {
  const offers = await fetchShoppingResults(query);
  insertSnapshots(query.toLowerCase(), category, offers);
  const analyzed = analyzeOffers(offers);
  return analyzed
    .filter((o) => o.verdict !== "normal")
    .sort((a, b) => b.score - a.score);
}

// POST /api/scan  { query: "PS5 slim", category: "gaming" }
app.post("/api/scan", async (req, res) => {
  const { query, category } = req.body || {};
  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: "Paramètre 'query' requis." });
  }
  try {
    const results = await scanQuery(query, category || "tout");
    res.json({ query, count: results.length, items: results });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
});

// POST /api/scan-watchlist  { list: "hightech" }
// Scanne toutes les requêtes prédéfinies d'une catégorie et fusionne les résultats.
app.post("/api/scan-watchlist", async (req, res) => {
  const { list } = req.body || {};
  const queries = WATCHLIST[list];
  if (!queries) {
    return res.status(400).json({ error: `Liste inconnue. Options : ${Object.keys(WATCHLIST).join(", ")}` });
  }
  try {
    const all = [];
    for (const q of queries) {
      const r = await scanQuery(q, list);
      all.push(...r);
    }
    all.sort((a, b) => b.score - a.score);
    res.json({ list, count: all.length, items: all });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
});

// GET /api/latest?query=...  — relit le dernier scan enregistré, sans en refaire un
// (utile pour un rafraîchissement rapide de page sans re-consommer de quota SerpApi).
app.get("/api/latest", (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "Paramètre 'query' requis." });
  const rows = latestSnapshots(query.toLowerCase());
  const analyzed = analyzeOffers(rows).filter((o) => o.verdict !== "normal");
  res.json({ query, count: analyzed.length, items: analyzed });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`RadarPrix backend en écoute sur le port ${PORT}`));
}

module.exports = app;
