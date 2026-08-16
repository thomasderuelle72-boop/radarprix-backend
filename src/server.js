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
  createUser,
  findUserByEmail,
  findUserById,
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
} = require("./db");
const { randomProductFor } = require("./catalog");
const { hashPassword, verifyPassword, generateToken, requireAuth, isValidEmail } = require("./auth");

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
    const token = generateToken(user);
    res.status(201).json({ token, user: { id: user.id, email: user.email } });
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
    const token = generateToken({ id: row.id, email: row.email });
    res.json({ token, user: { id: row.id, email: row.email } });
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

app.get("/api/health", (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`RadarPrix backend en écoute sur le port ${PORT}`));
}

module.exports = app;
