// server.js — API RadarPrix. Ne parle jamais directement au navigateur
// des visiteurs à SerpApi : la clé API reste ici, côté serveur, secrète.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { fetchShoppingResults, resolveDirectLink } = require("./serpapi");
const { analyzeOffers, filterRelevantOffers } = require("./algorithm");
const {
  insertSnapshots,
  latestSnapshots,
  latestBatchPerProduct,
  createUser,
  findUserByEmail,
  findUserById,
  promoteToAdmin,
  countUsers,
  countScans,
  topScannedProducts,
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
} = require("./db");
const { randomProductFor } = require("./catalog");
const { hashPassword, verifyPassword, generateToken, requireAuth, requireAdmin, isDesignatedAdminEmail, isValidEmail } = require("./auth");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// On ne résout le vrai lien marchand (1 requête SerpApi de plus chacun)
// que pour les meilleures offres affichées — pas pour toute la liste,
// pour rester raisonnable sur le quota.
const MAX_DIRECT_LINKS = 6;

/** Lance un scan réel (SerpApi) pour une requête, l'analyse, le stocke. */
async function scanQuery(query, category = "tout") {
  const rawOffers = await fetchShoppingResults(query);
  // On écarte les accessoires et hors-sujet AVANT toute analyse de prix :
  // sinon une coque à 15€ fausse la médiane de référence du vrai produit.
  const offers = filterRelevantOffers(rawOffers, query);
  insertSnapshots(query.toLowerCase(), category, offers);
  const analyzed = analyzeOffers(offers)
    .filter((o) => o.verdict !== "normal")
    .sort((a, b) => b.score - a.score);

  // Résout les vrais liens marchands pour le haut du classement.
  const top = analyzed.slice(0, MAX_DIRECT_LINKS);
  const rest = analyzed.slice(MAX_DIRECT_LINKS).map((o) => ({ ...o, url: null }));

  for (const item of top) {
    if (item._token) {
      const directLink = await resolveDirectLink(item._token, item.seller, item.price);
      item.url = directLink || null; // jamais le lien Google en repli : soit le vrai lien, soit rien
    } else {
      item.url = null;
    }
    delete item._token;
  }
  rest.forEach((o) => delete o._token);

  return [...top, ...rest];
}

// GET /api/deals?category=gaming&page=1&pageSize=15
// Lit tous les deals déjà repérés en base (par le cron ou des scans précédents),
// groupés par produit, analysés, fusionnés, triés par score, puis paginés.
// AUCUN appel SerpApi ici : réponse instantanée, gratuite, appelable sans limite.
app.get("/api/deals", (req, res) => {
  const category = req.query.category || "tout";
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 15));

  const batches = latestBatchPerProduct(category);
  const allFlagged = [];
  for (const { offers } of batches) {
    if (offers.length === 0) continue;
    const relevant = filterRelevantOffers(offers, offers[0].name);
    const analyzed = analyzeOffers(relevant).filter((o) => o.verdict !== "normal");
    allFlagged.push(...analyzed);
  }
  allFlagged.sort((a, b) => b.score - a.score);

  const total = allFlagged.length;
  const start = (page - 1) * pageSize;
  const pageItems = allFlagged.slice(start, start + pageSize).map(({ _token, ...clean }) => clean);

  res.json({
    category,
    page,
    pageSize,
    total,
    hasMore: start + pageSize < total,
    items: pageItems,
  });
});

// POST /api/scan  { query?: "PS5 slim", category?: "gaming" }
// Si "query" est fourni, on scanne exactement ce produit.
// Sinon, on tire un produit réel au hasard dans la catégorie demandée.
app.post("/api/scan", async (req, res) => {
  const { query, category } = req.body || {};
  const effectiveQuery = query && query.trim() ? query.trim() : randomProductFor(category);
  try {
    const results = await scanQuery(effectiveQuery, category || "tout");
    res.json({ query: effectiveQuery, count: results.length, items: results });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
});

// GET /api/latest?query=...  — relit le dernier scan enregistré, sans en refaire un.
app.get("/api/latest", (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "Paramètre 'query' requis." });
  const rows = latestSnapshots(query.toLowerCase());
  const analyzed = analyzeOffers(rows).filter((o) => o.verdict !== "normal");
  res.json({ query, count: analyzed.length, items: analyzed });
});

// ── Comptes utilisateurs ────────────────────────────────────────

// POST /api/auth/register  { email, password }
app.post("/api/auth/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: "Adresse email invalide." });
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "Le mot de passe doit faire au moins 8 caractères." });
  }
  if (findUserByEmail(email)) {
    return res.status(409).json({ error: "Un compte existe déjà avec cet email." });
  }
  try {
    const passwordHash = await hashPassword(password);
    const user = createUser(email, passwordHash);
    if (isDesignatedAdminEmail(user.email)) promoteToAdmin(user.id);
    const fullUser = findUserById(user.id);
    const token = generateToken(fullUser);
    res.status(201).json({ token, user: fullUser });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/login  { email, password }
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const row = email && findUserByEmail(email);
  const ok = row && (await verifyPassword(password || "", row.password_hash));
  if (!ok) return res.status(401).json({ error: "Email ou mot de passe incorrect." });
  try {
    if (isDesignatedAdminEmail(row.email)) promoteToAdmin(row.id);
    const fullUser = findUserById(row.id);
    const token = generateToken(fullUser);
    res.json({ token, user: fullUser });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/me — vérifie le jeton et renvoie le profil courant.
app.get("/api/auth/me", requireAuth, (req, res) => {
  const user = findUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });
  res.json({ user });
});

// ── Favoris / recherches suivies (nécessite un compte) ──────────

app.get("/api/watchlist", requireAuth, (req, res) => {
  res.json({ items: getWatchlist(req.user.sub) });
});

app.post("/api/watchlist", requireAuth, (req, res) => {
  const { query, category } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: "Paramètre 'query' requis." });
  addToWatchlist(req.user.sub, query, category);
  res.status(201).json({ items: getWatchlist(req.user.sub) });
});

app.delete("/api/watchlist", requireAuth, (req, res) => {
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: "Paramètre 'query' requis." });
  removeFromWatchlist(req.user.sub, query);
  res.json({ items: getWatchlist(req.user.sub) });
});

// ── Administration (réservé au créateur du site) ────────────────

app.get("/api/admin/stats", requireAuth, requireAdmin, (req, res) => {
  res.json({
    totalUsers: countUsers(),
    totalScans: countScans(),
    topProducts: topScannedProducts(10),
  });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`RadarPrix backend en écoute sur le port ${PORT}`));
}

module.exports = app;
