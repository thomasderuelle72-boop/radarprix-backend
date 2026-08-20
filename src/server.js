// server.js — API RadarPrix. Ne parle jamais directement au navigateur
// des visiteurs à SerpApi : la clé API reste ici, côté serveur, secrète.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { resolveDirectLink } = require("./serpapi");
const { fetchLiveOffers } = require("./fetchOffers");
const {
  analyzeOffers, filterRelevantOffers,
  isAccessoryTitle, isUsedOrRefurbishedTitle, titleMatchesQuery,
} = require("./algorithm");
const {
  insertSnapshots,
  latestSnapshots,
  latestBatchPerProduct,
  priceHistoryByDay,
  createUser,
  findUserByEmail,
  findUserByIdWithHash,
  updatePassword,
  deleteAccount,
  findUserById,
  updateProfile,
  listUsers,
  listMembersPublic,
  publicProfile,
  userStats,
  userActivity,
  userDeals,
  userThreads,
  badgeEventDates,
  followUser,
  unfollowUser,
  isFollowing,
  listFollowing,
  dealsFromFollowed,
  promoteToAdmin,
  countUsers,
  countScans,
  topScannedProducts,
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
  addComment,
  listComments,
  sendMessage,
  listPublicMessages,
  listConversation,
  listConversationsFor,
  markConversationRead,
  countUnreadMessages,
  TYPES_CONTENU,
  lireContenu,
  supprimerContenu,
  journaliser,
  listModerationLog,
  signalerContenu,
  listReports,
  countOpenReports,
  rejeterSignalement,
  suspendreMembre,
  suspensionEnCours,
  definirRole,
  epinglerDeal,
  listScanRuns,
  sourceHealth,
  listEmailLog,
  emailStats,
  submitCommunityDeal,
  getCommunityDeal,
  merchantReliability,
  listCommunityDeals,
  voteCommunityDeal,
  removeCommunityVote,
  getUserVote,
  listForumCategories,
  getForumCategoryBySlug,
  listForumThreads,
  getForumThread,
  createForumThread,
  listForumReplies,
  addForumReply,
} = require("./db");
const { randomProductFor } = require("./catalog");
const { runCatalogBatch } = require("./scanBatch");
const { hashPassword, verifyPassword, generateToken, requireAuth, optionalAuth, requireAdmin, isDesignatedAdminEmail, isValidEmail } = require("./auth");
const { hotScore } = require("./ranking");
const { calculerBadges, prochainsBadges } = require("./badges");
const { validerTexte, limiterFrequence, refuserDoublon } = require("./moderation");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// On ne résout le vrai lien marchand (1 requête SerpApi de plus chacun)
// que pour les meilleures offres affichées — pas pour toute la liste,
// pour rester raisonnable sur le quota.
const MAX_DIRECT_LINKS = 6;

/** Lance un scan réel pour une requête, l'analyse, le stocke. */
async function scanQuery(query, category = "tout") {
  const rawOffers = await fetchLiveOffers(query);
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

// Compare deux chaînes en ignorant casse et accents, pour que "reconditionné"
// et "reconditionne" (ou une saisie sans accent côté utilisateur) matchent.
function foldAccents(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}


/**
 * Un membre suspendu peut continuer à lire le site, mais plus à y publier.
 * Le contrôle vit ici plutôt que dans chaque route : il y a huit points de
 * publication, en oublier un viderait la sanction de son sens.
 */
function refuserSiSuspendu(req, res, next) {
  const s = suspensionEnCours(req.user.sub);
  if (!s) return next();
  const fin = new Date(s.jusquA.replace(" ", "T") + "Z").toLocaleDateString("fr-FR");
  return res.status(403).json({
    error: `Ton compte est suspendu jusqu'au ${fin}${s.motif ? " — " + s.motif : ""}.`,
    suspendu: true,
  });
}

/** Modérateur ou administrateur : accès aux outils de modération. */
function requireModerator(req, res, next) {
  if (req.user?.role !== "admin" && req.user?.role !== "moderator") {
    return res.status(403).json({ error: "Accès réservé à la modération." });
  }
  next();
}

// GET /api/deals?category=gaming&page=1&pageSize=15&q=pc
// Lit tous les deals déjà repérés en base (par le cron ou des scans précédents),
// groupés par produit, analysés, fusionnés, triés par score, puis paginés.
// AUCUN appel SerpApi ici : réponse instantanée, gratuite, appelable sans limite.
// Le paramètre optionnel "q" filtre par mot-clé sur des deals DÉJÀ validés
// individuellement (chacun comparé à ses propres pairs/historique) : une
// recherche large comme "pc" peut ainsi parcourir tout ce qui a été détecté
// sur des PC, sans jamais comparer entre eux des produits différents (voir
// analyzeOffers/clusterByProduct) — contrairement à un scan en direct sur un
// terme aussi vague, qui n'a par nature aucune base de comparaison fiable.
app.get("/api/deals", (req, res) => {
  const category = req.query.category || "tout";
  const q = foldAccents((req.query.q || "").trim());
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 15));

  const batches = latestBatchPerProduct(category);
  const allFlagged = [];
  for (const { query, offers } of batches) {
    if (offers.length === 0) continue;
    const relevant = filterRelevantOffers(offers, query);
    const analyzed = analyzeOffers(relevant).filter((o) => o.verdict !== "normal");
    allFlagged.push(...analyzed);
  }
  const matching = q ? allFlagged.filter((o) => foldAccents(o.name).includes(q)) : allFlagged;
  matching.sort((a, b) => b.score - a.score);

  const total = matching.length;
  const start = (page - 1) * pageSize;
  const pageItems = matching.slice(start, start + pageSize).map(({ _token, ...clean }) => clean);

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

// PATCH /api/auth/me  { pseudo?, avatarUrl? } — modifie son propre profil.
app.patch("/api/auth/me", requireAuth, (req, res) => {
  const { pseudo, avatarUrl } = req.body || {};
  if (pseudo !== undefined && (typeof pseudo !== "string" || pseudo.length > 30)) {
    return res.status(400).json({ error: "Le pseudo doit faire 30 caractères maximum." });
  }
  // Deux formes acceptées : un lien vers une image hébergée ailleurs, ou une
  // photo choisie sur l'appareil — que le navigateur nous envoie déjà
  // redimensionnée, sous forme de données intégrées (data:image/...). Cette
  // seconde forme était refusée ici alors que le site la produisait : le
  // bouton "Choisir une photo" échouait systématiquement.
  if (avatarUrl !== undefined && avatarUrl) {
    const lien = /^https?:\/\//.test(avatarUrl);
    const integree = /^data:image\/(jpeg|png|webp);base64,/.test(avatarUrl);
    if (!lien && !integree) {
      return res.status(400).json({ error: "Photo invalide : indique un lien http(s) ou choisis une image." });
    }
    // La photo est stockée dans la base et renvoyée avec chaque commentaire :
    // au-delà de ~150 Ko elle alourdirait toutes les pages du site.
    if (avatarUrl.length > 150 * 1024) {
      return res.status(400).json({ error: "Photo trop lourde. Choisis une image plus petite." });
    }
  }
  const maj = updateProfile(req.user.sub, {
    pseudo: pseudo !== undefined ? pseudo.trim().slice(0, 30) : undefined,
    avatarUrl: avatarUrl !== undefined ? avatarUrl.trim() : undefined,
  });
  if (!maj.ok) return res.status(409).json({ error: maj.error });
  res.json({ user: maj.user });
});

// PATCH /api/auth/password  { currentPassword, newPassword } — nécessite le mot de passe actuel.
app.patch("/api/auth/password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "Le nouveau mot de passe doit faire au moins 8 caractères." });
  }
  const row = findUserByIdWithHash(req.user.sub);
  const ok = row && (await verifyPassword(currentPassword || "", row.password_hash));
  if (!ok) return res.status(401).json({ error: "Mot de passe actuel incorrect." });
  const newHash = await hashPassword(newPassword);
  updatePassword(req.user.sub, newHash);
  res.json({ ok: true });
});

// DELETE /api/auth/me  { password } — suppression définitive du compte, confirmée par le mot de passe.
app.delete("/api/auth/me", requireAuth, async (req, res) => {
  const { password } = req.body || {};
  const row = findUserByIdWithHash(req.user.sub);
  const ok = row && (await verifyPassword(password || "", row.password_hash));
  if (!ok) return res.status(401).json({ error: "Mot de passe incorrect — suppression annulée." });
  deleteAccount(req.user.sub);
  res.json({ ok: true });
});

// ── Favoris / recherches suivies (nécessite un compte) ──────────

app.get("/api/watchlist", requireAuth, (req, res) => {
  res.json({ items: getWatchlist(req.user.sub) });
});

app.post("/api/watchlist", requireAuth, (req, res) => {
  const { query, category, targetPrice } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: "Paramètre 'query' requis." });
  // targetPrice est optionnel : absent = alerte uniquement sur erreur de prix.
  if (targetPrice != null && targetPrice !== "" && !(Number(targetPrice) > 0)) {
    return res.status(400).json({ error: "'targetPrice' doit être un prix positif." });
  }
  addToWatchlist(req.user.sub, query, category, targetPrice);
  res.status(201).json({ items: getWatchlist(req.user.sub) });
});

app.delete("/api/watchlist", requireAuth, (req, res) => {
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: "Paramètre 'query' requis." });
  removeFromWatchlist(req.user.sub, query);
  res.json({ items: getWatchlist(req.user.sub) });
});

// GET /api/history?query=... — historique de prix par jour, pour un mini-graphique.
app.get("/api/history", (req, res) => {
  const { query, days } = req.query;
  if (!query) return res.status(400).json({ error: "Paramètre 'query' requis." });
  res.json({ query, days: priceHistoryByDay(query, parseInt(days, 10) || 30) });
});

// ── Commentaires (sous un deal) ──────────────────────────────────

app.get("/api/comments", (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "Paramètre 'query' requis." });
  res.json({ items: listComments(query) });
});

app.post("/api/comments", requireAuth, refuserSiSuspendu, (req, res) => {
  const { query, body } = req.body || {};
  if (!query) return res.status(400).json({ error: "Paramètre 'query' requis." });
  const texte = validerTexte(body, "comment");
  if (!texte.ok) return res.status(400).json({ error: texte.error });
  const debit = limiterFrequence(req.user.sub, "comment", 5, 60000);
  if (!debit.ok) return res.status(429).json({ error: debit.error });
  const doublon = refuserDoublon(req.user.sub, texte.value);
  if (!doublon.ok) return res.status(409).json({ error: doublon.error });
  addComment(query, req.user.sub, texte.value);
  res.status(201).json({ items: listComments(query) });
});

// ── Messagerie : salon général public + messages privés ─────────

// GET /api/members — liste des membres (sans email), pour démarrer une conversation.
app.get("/api/members", requireAuth, (req, res) => {
  res.json({ items: listMembersPublic(req.user.sub) });
});

// ── Profils publics de membres ───────────────────────────────────
//
// Consultables sans être connecté : c'est ce qui permet à un membre de
// partager son profil, et à un visiteur de juger qui a publié un deal avant
// de faire confiance au prix annoncé.

/** Résout :handle (id ou pseudo) et renvoie 404 proprement si inconnu. */
function chargerMembre(req, res) {
  const membre = publicProfile(req.params.handle);
  if (!membre) {
    res.status(404).json({ error: "Membre introuvable." });
    return null;
  }
  return membre;
}

// GET /api/members/:handle — fiche complète : profil, chiffres, badges.
app.get("/api/members/:handle", optionalAuth, (req, res) => {
  const membre = chargerMembre(req, res);
  if (!membre) return;
  const evenements = badgeEventDates(membre.id);
  res.json({
    membre,
    stats: userStats(membre.id),
    badges: calculerBadges(evenements),
    prochainsBadges: prochainsBadges(evenements),
    jeLeSuis: req.user ? isFollowing(req.user.sub, membre.id) : false,
    cestMoi: req.user ? req.user.sub === membre.id : false,
  });
});

// GET /api/members/:handle/activity — tout ce qu'il a publié, toutes sections confondues.
app.get("/api/members/:handle/activity", (req, res) => {
  const membre = chargerMembre(req, res);
  if (!membre) return;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
  res.json({ items: userActivity(membre.id, limit) });
});

// GET /api/members/:handle/deals — ses deals communautaires.
app.get("/api/members/:handle/deals", optionalAuth, (req, res) => {
  const membre = chargerMembre(req, res);
  if (!membre) return;
  const items = userDeals(membre.id).map((d) => ({
    ...d,
    score: hotScore(d.upvotes, d.downvotes, d.created_at),
    myVote: req.user ? getUserVote(d.id, req.user.sub) : null,
  }));
  res.json({ items });
});

// GET /api/members/:handle/threads — ses sujets de forum.
app.get("/api/members/:handle/threads", (req, res) => {
  const membre = chargerMembre(req, res);
  if (!membre) return;
  res.json({ items: userThreads(membre.id) });
});

// POST /api/members/:handle/follow — s'abonner à ce membre.
app.post("/api/members/:handle/follow", requireAuth, (req, res) => {
  const membre = chargerMembre(req, res);
  if (!membre) return;
  const r = followUser(req.user.sub, membre.id);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ jeLeSuis: true, abonnes: userStats(membre.id).abonnes });
});

// DELETE /api/members/:handle/follow — se désabonner.
app.delete("/api/members/:handle/follow", requireAuth, (req, res) => {
  const membre = chargerMembre(req, res);
  if (!membre) return;
  unfollowUser(req.user.sub, membre.id);
  res.json({ jeLeSuis: false, abonnes: userStats(membre.id).abonnes });
});

// GET /api/feed/following — les deals publiés par les membres qu'on suit.
app.get("/api/feed/following", requireAuth, (req, res) => {
  const items = dealsFromFollowed(req.user.sub).map((d) => ({
    ...d,
    score: hotScore(d.upvotes, d.downvotes, d.created_at),
    myVote: getUserVote(d.id, req.user.sub),
  }));
  res.json({ suivis: listFollowing(req.user.sub), items });
});

// GET /api/chat/public?afterId=0 — messages du salon général, à sonder régulièrement.
app.get("/api/chat/public", (req, res) => {
  const afterId = parseInt(req.query.afterId, 10) || 0;
  res.json({ items: listPublicMessages(afterId) });
});

app.post("/api/chat/public", requireAuth, refuserSiSuspendu, (req, res) => {
  const texte = validerTexte(req.body?.body, "message");
  if (!texte.ok) return res.status(400).json({ error: texte.error });
  // Salon en direct : plafond plus haut qu'ailleurs, une conversation
  // normale enchaîne facilement plusieurs messages courts d'affilée.
  const debit = limiterFrequence(req.user.sub, "chat", 12, 60000);
  if (!debit.ok) return res.status(429).json({ error: debit.error });
  const id = sendMessage(req.user.sub, null, texte.value);
  res.status(201).json({ id });
});

// GET /api/chat/conversations — mes conversations privées, avec dernier
// message et nombre de messages en attente pour chacune.
app.get("/api/chat/conversations", requireAuth, (req, res) => {
  res.json({
    items: listConversationsFor(req.user.sub),
    nonLus: countUnreadMessages(req.user.sub),
  });
});

// GET /api/chat/with/:userId — historique d'une conversation privée avec un membre.
app.get("/api/chat/with/:userId", requireAuth, (req, res) => {
  const otherId = parseInt(req.params.userId, 10);
  if (!otherId) return res.status(400).json({ error: "Identifiant invalide." });
  // Ouvrir un fil vaut lecture : c'est le seul instant où l'on sait de façon
  // fiable que le destinataire a les messages sous les yeux. `read=0` permet
  // au sondage régulier de relire un fil sans marquer quoi que ce soit.
  if (req.query.read !== "0") markConversationRead(req.user.sub, otherId);
  res.json({ items: listConversation(req.user.sub, otherId) });
});

app.post("/api/chat/with/:userId", requireAuth, refuserSiSuspendu, (req, res) => {
  const otherId = parseInt(req.params.userId, 10);
  const { body } = req.body || {};
  if (!otherId) return res.status(400).json({ error: "Identifiant invalide." });
  const texte = validerTexte(body, "message");
  if (!texte.ok) return res.status(400).json({ error: texte.error });
  const debit = limiterFrequence(req.user.sub, "dm", 12, 60000);
  if (!debit.ok) return res.status(429).json({ error: debit.error });
  const id = sendMessage(req.user.sub, otherId, texte.value);
  res.status(201).json({ id });
});

// ── Communauté : deals soumis par les membres + votes de pertinence ──

// GET /api/community/deals?category=tout&sort=hot&page=1&pageSize=20
// "hot" = classé par l'indicateur de pertinence (votes + fraîcheur), "new" = plus récents d'abord.
app.get("/api/community/deals", optionalAuth, (req, res) => {
  const category = req.query.category || "tout";
  const sort = req.query.sort === "new" ? "new" : "hot";
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 20));

  // On relit une fenêtre large avant de trier par score, car le score dépend
  // du temps écoulé et ne peut pas être calculé directement en SQL simple.
  const rows = listCommunityDeals(category, 500, 0);
  if (sort === "hot") {
    rows.sort((a, b) => hotScore(b.upvotes, b.downvotes, b.created_at) - hotScore(a.upvotes, a.downvotes, a.created_at));
  }
  // Les deals épinglés passent devant, quel que soit le tri demandé : c'est
  // tout l'intérêt de l'épinglage. Entre eux, le plus récemment épinglé
  // d'abord ; le reste garde l'ordre déjà calculé.
  rows.sort((a, b) => {
    if (Boolean(a.pinned_at) === Boolean(b.pinned_at)) return 0;
    return a.pinned_at ? -1 : 1;
  });
  const total = rows.length;
  const start = (page - 1) * pageSize;
  const items = rows.slice(start, start + pageSize).map((d) => ({
    ...d,
    score: hotScore(d.upvotes, d.downvotes, d.created_at),
    myVote: req.user ? getUserVote(d.id, req.user.sub) : null,
  }));
  res.json({ category, sort, page, pageSize, total, hasMore: start + pageSize < total, items });
});

/**
 * Date de fin d'une offre, telle que saisie dans le formulaire ("2026-08-31"
 * ou une date-heure ISO). Renvoie une date SQLite, ou null si le champ est
 * vide ou inexploitable — une date d'expiration reste facultative, on ne
 * bloque pas une publication pour ça.
 */
function normaliserExpiration(valeur) {
  if (!valeur) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(valeur) ? `${valeur}T23:59:59Z` : valeur);
  if (Number.isNaN(d.getTime())) return null;
  // Une offre déjà terminée n'a pas de sens ; on ignore plutôt que refuser.
  if (d.getTime() < Date.now()) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// POST /api/community/deals  { title, description?, url?, price?, imageUrl?, category?, seller?, expiresAt? }
app.post("/api/community/deals", requireAuth, refuserSiSuspendu, (req, res) => {
  const { title, description, url, price, imageUrl, category, seller, expiresAt } = req.body || {};
  const titreOk = validerTexte(title, "dealTitle");
  if (!titreOk.ok) return res.status(400).json({ error: titreOk.error });
  if (description && description.trim()) {
    const descOk = validerTexte(description, "dealDescription");
    if (!descOk.ok) return res.status(400).json({ error: descOk.error });
  }
  if (url && !/^https?:\/\//.test(url)) return res.status(400).json({ error: "L'URL doit commencer par http:// ou https://" });
  // Publier un deal est un acte rare : plafond bas, c'est le contenu le
  // plus exposé au spam commercial.
  const debitDeal = limiterFrequence(req.user.sub, "deal", 3, 300000);
  if (!debitDeal.ok) return res.status(429).json({ error: debitDeal.error });
  const deal = submitCommunityDeal(req.user.sub, {
    title: title.trim(),
    description: description ? description.trim() : null,
    url: url ? url.trim() : null,
    price: price !== undefined && price !== null && price !== "" ? Number(price) : null,
    imageUrl: imageUrl ? imageUrl.trim() : null,
    category: category || "tout",
    seller: seller ? seller.trim() : null,
    expiresAt: normaliserExpiration(expiresAt),
  });
  res.status(201).json({ deal: { ...deal, score: hotScore(deal.upvotes, deal.downvotes, deal.created_at) } });
});

// GET /api/merchants/reliability?name=Amazon — fiabilité perçue par la
// communauté (ratio de votes positifs sur les deals qui mentionnent ce
// marchand). Distinct du Deal/Confidence Score : c'est un avis collectif
// sur le vendeur, pas une mesure algorithmique sur un prix précis.
app.get("/api/merchants/reliability", (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: "Paramètre 'name' requis." });
  res.json(merchantReliability(name));
});

// POST /api/community/deals/:id/vote  { value: 1 | -1 }
app.post("/api/community/deals/:id/vote", requireAuth, refuserSiSuspendu, (req, res) => {
  const dealId = parseInt(req.params.id, 10);
  const { value } = req.body || {};
  if (!dealId) return res.status(400).json({ error: "Identifiant invalide." });
  if (value !== 1 && value !== -1) return res.status(400).json({ error: "value doit être 1 ou -1." });
  if (!getCommunityDeal(dealId)) return res.status(404).json({ error: "Deal introuvable." });
  const deal = voteCommunityDeal(dealId, req.user.sub, value);
  res.json({ deal: { ...deal, score: hotScore(deal.upvotes, deal.downvotes, deal.created_at), myVote: value } });
});

// DELETE /api/community/deals/:id/vote — retire son vote.
app.delete("/api/community/deals/:id/vote", requireAuth, (req, res) => {
  const dealId = parseInt(req.params.id, 10);
  if (!dealId) return res.status(400).json({ error: "Identifiant invalide." });
  if (!getCommunityDeal(dealId)) return res.status(404).json({ error: "Deal introuvable." });
  const deal = removeCommunityVote(dealId, req.user.sub);
  res.json({ deal: { ...deal, score: hotScore(deal.upvotes, deal.downvotes, deal.created_at), myVote: null } });
});

// ── Forum : catégories, sujets, réponses ─────────────────────────

app.get("/api/forum/categories", (req, res) => {
  res.json({ items: listForumCategories() });
});

// GET /api/forum/categories/:slug/threads
app.get("/api/forum/categories/:slug/threads", (req, res) => {
  const cat = getForumCategoryBySlug(req.params.slug);
  if (!cat) return res.status(404).json({ error: "Catégorie introuvable." });
  res.json({ category: cat, items: listForumThreads(cat.id, 100) });
});

// POST /api/forum/categories/:slug/threads  { title, body }
app.post("/api/forum/categories/:slug/threads", requireAuth, refuserSiSuspendu, (req, res) => {
  const cat = getForumCategoryBySlug(req.params.slug);
  if (!cat) return res.status(404).json({ error: "Catégorie introuvable." });
  const { title, body } = req.body || {};
  const titreOk = validerTexte(title, "title");
  if (!titreOk.ok) return res.status(400).json({ error: titreOk.error });
  const corpsOk = validerTexte(body, "thread");
  if (!corpsOk.ok) return res.status(400).json({ error: corpsOk.error });
  const debitSujet = limiterFrequence(req.user.sub, "thread", 3, 300000);
  if (!debitSujet.ok) return res.status(429).json({ error: debitSujet.error });
  const thread = createForumThread(cat.id, req.user.sub, titreOk.value, corpsOk.value);
  res.status(201).json({ thread });
});

// GET /api/forum/threads/:id — sujet + toutes ses réponses.
app.get("/api/forum/threads/:id", (req, res) => {
  const threadId = parseInt(req.params.id, 10);
  const thread = threadId && getForumThread(threadId);
  if (!thread) return res.status(404).json({ error: "Sujet introuvable." });
  res.json({ thread, replies: listForumReplies(threadId) });
});

// POST /api/forum/threads/:id/replies  { body }
app.post("/api/forum/threads/:id/replies", requireAuth, refuserSiSuspendu, (req, res) => {
  const threadId = parseInt(req.params.id, 10);
  const thread = threadId && getForumThread(threadId);
  if (!thread) return res.status(404).json({ error: "Sujet introuvable." });
  const { body } = req.body || {};
  const reponseOk = validerTexte(body, "reply");
  if (!reponseOk.ok) return res.status(400).json({ error: reponseOk.error });
  const debitReponse = limiterFrequence(req.user.sub, "reply", 8, 60000);
  if (!debitReponse.ok) return res.status(429).json({ error: debitReponse.error });
  const replies = addForumReply(threadId, req.user.sub, reponseOk.value);
  res.status(201).json({ replies });
});

// ── Administration (réservé au créateur du site) ────────────────


// ── Signalement d'un contenu (côté membre) ──────────────────────

const MOTIFS_SIGNALEMENT = ["spam", "arnaque", "offensant", "hors-sujet", "doublon", "autre"];

// POST /api/reports  { type, id, reason, note? }
app.post("/api/reports", requireAuth, (req, res) => {
  const { type, id, reason, note } = req.body || {};
  if (!TYPES_CONTENU.includes(type)) return res.status(400).json({ error: "Type de contenu inconnu." });
  if (!MOTIFS_SIGNALEMENT.includes(reason)) return res.status(400).json({ error: "Motif invalide." });
  if (note && String(note).length > 500) return res.status(400).json({ error: "Précision trop longue." });
  // Un signalement coûte peu à envoyer et beaucoup à traiter : on plafonne.
  const debit = limiterFrequence(req.user.sub, "report", 10, 600000);
  if (!debit.ok) return res.status(429).json({ error: debit.error });

  const r = signalerContenu(req.user.sub, type, parseInt(id, 10), reason, note);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json({ ok: true, deja: Boolean(r.deja) });
});

// GET /api/reports/motifs — la liste que le formulaire doit proposer.
app.get("/api/reports/motifs", (req, res) => res.json({ motifs: MOTIFS_SIGNALEMENT }));

// ── Modération (modérateur ou administrateur) ────────────────────

// GET /api/moderation/reports?status=ouvert
app.get("/api/moderation/reports", requireAuth, requireModerator, (req, res) => {
  const statut = ["ouvert", "traite", "rejete", "tous"].includes(req.query.status) ? req.query.status : "ouvert";
  res.json({ items: listReports(statut), ouverts: countOpenReports() });
});

// DELETE /api/moderation/content/:type/:id  { motif? }
app.delete("/api/moderation/content/:type/:id", requireAuth, requireModerator, (req, res) => {
  const { type, id } = req.params;
  const r = supprimerContenu(req.user.sub, type, parseInt(id, 10), req.body?.motif);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, supprime: r.contenu, ouverts: countOpenReports() });
});

// POST /api/moderation/reports/:id/reject — fausse alerte, on classe sans suite.
app.post("/api/moderation/reports/:id/reject", requireAuth, requireModerator, (req, res) => {
  const fait = rejeterSignalement(req.user.sub, parseInt(req.params.id, 10));
  if (!fait) return res.status(404).json({ error: "Signalement introuvable ou déjà traité." });
  res.json({ ok: true, ouverts: countOpenReports() });
});

// POST /api/moderation/users/:id/suspend  { jours, motif? }  (jours = 0 : lever)
app.post("/api/moderation/users/:id/suspend", requireAuth, requireModerator, (req, res) => {
  const jours = Math.min(365, Math.max(0, parseInt(req.body?.jours, 10) || 0));
  const r = suspendreMembre(req.user.sub, parseInt(req.params.id, 10), jours, req.body?.motif);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, jusquA: r.jusquA });
});

// POST /api/moderation/deals/:id/pin  { epingle: true|false }
app.post("/api/moderation/deals/:id/pin", requireAuth, requireModerator, (req, res) => {
  const r = epinglerDeal(req.user.sub, parseInt(req.params.id, 10), Boolean(req.body?.epingle));
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
});

// GET /api/moderation/log — journal des actions.
app.get("/api/moderation/log", requireAuth, requireModerator, (req, res) => {
  res.json({ items: listModerationLog(Math.min(300, parseInt(req.query.limit, 10) || 100)) });
});

// ── Rôles (administrateur seulement) ─────────────────────────────
// POST /api/admin/users/:id/role  { role }
app.post("/api/admin/users/:id/role", requireAuth, requireAdmin, (req, res) => {
  const r = definirRole(req.user.sub, parseInt(req.params.id, 10), req.body?.role);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
});


// ── Santé du site ────────────────────────────────────────────────

// GET /api/admin/health — état des services extérieurs et du scan.
app.get("/api/admin/health", requireAuth, requireModerator, (req, res) => {
  const runs = listScanRuns(1);
  res.json({
    sources: sourceHealth(),
    dernierScan: runs[0] || null,
    emails: emailStats(),
    cronActif: process.env.ENABLE_CRON !== "false",
    // Ce que le serveur a réellement en main : une clé absente explique un
    // service muet bien plus sûrement qu'une panne.
    clesPresentes: {
      serpapi: Boolean(process.env.SERPAPI_KEY),
      brightdata: Boolean(process.env.BRIGHT_DATA_BROWSER_HOST),
      resend: Boolean(process.env.RESEND_API_KEY),
      adminEmail: Boolean(process.env.ADMIN_EMAIL),
    },
  });
});

// GET /api/admin/scans — historique des exécutions de scan.
app.get("/api/admin/scans", requireAuth, requireModerator, (req, res) => {
  res.json({ items: listScanRuns(Math.min(100, parseInt(req.query.limit, 10) || 30)) });
});

// GET /api/admin/emails — journal des emails envoyés.
app.get("/api/admin/emails", requireAuth, requireModerator, (req, res) => {
  res.json({ items: listEmailLog(Math.min(200, parseInt(req.query.limit, 10) || 50)), stats: emailStats() });
});

// POST /api/admin/diagnose  { query }
// Rejoue un produit et montre le raisonnement complet : ce qui a été
// récupéré, ce qui a été écarté et pour quelle raison, puis ce que
// l'algorithme en a conclu. Le bouton de scan existant lançait le travail
// sans jamais rien montrer, ce qui le rendait inutile pour comprendre un
// mauvais résultat.
app.post("/api/admin/diagnose", requireAuth, requireAdmin, async (req, res) => {
  const query = String(req.body?.query || "").trim();
  if (!query) return res.status(400).json({ error: "Indique un produit à diagnostiquer." });
  const debit = limiterFrequence(req.user.sub, "diagnostic", 6, 600000);
  if (!debit.ok) return res.status(429).json({ error: debit.error });

  try {
    const brutes = await fetchLiveOffers(query);
    const retenues = filterRelevantOffers(brutes, query);
    const gardees = new Set(retenues.map((o) => `${o.seller}|${o.name}|${o.price}`));

    // Pour chaque offre écartée, la raison exacte — dans le même ordre que
    // filterRelevantOffers les applique.
    const ecartees = brutes
      .filter((o) => !gardees.has(`${o.seller}|${o.name}|${o.price}`))
      .map((o) => ({
        name: o.name,
        seller: o.seller,
        price: o.price,
        raison: isAccessoryTitle(o.name)
          ? "accessoire (coque, câble, protection…)"
          : isUsedOrRefurbishedTitle(o.name)
          ? "occasion ou reconditionné"
          : !titleMatchesQuery(o.name, query)
          ? "titre trop éloigné du produit demandé"
          : "écartée par le filtrage",
      }));

    const analysees = analyzeOffers(retenues).map(({ _token, ...o }) => o);
    res.json({
      query,
      brutes: brutes.length,
      retenues: retenues.map(({ _token, ...o }) => o),
      ecartees,
      analysees,
      anomalies: analysees.filter((o) => o.verdict !== "normal").length,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/admin/stats", requireAuth, requireAdmin, (req, res) => {
  res.json({
    totalUsers: countUsers(),
    totalScans: countScans(),
    topProducts: topScannedProducts(10),
  });
});

app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  res.json({ users: listUsers(200) });
});

// Lance immédiatement un lot de scans catalogue (au lieu d'attendre le
// prochain passage du cron). Consomme du quota SerpApi à chaque appel :
// bouton à utiliser avec modération, pas pour un rafraîchissement en boucle.
app.post("/api/admin/trigger-scan", requireAuth, requireAdmin, async (req, res) => {
  const size = Math.min(20, Math.max(1, parseInt(req.body?.size, 10) || 10));
  // Chaque produit scanné consomme une requête SerpApi, et le quota est
  // mensuel : quelques clics rapides pouvaient vider ce qui restait. Deux
  // lancements par quart d'heure suffisent largement à un usage manuel.
  const debit = limiterFrequence(req.user.sub, "scan-manuel", 2, 900000);
  if (!debit.ok) return res.status(429).json({ error: debit.error });
  try {
    const results = await runCatalogBatch(size, { source: "manuel", triggeredBy: req.user.sub });
    res.json({ scanned: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`RadarPrix backend en écoute sur le port ${PORT}`));

  // Sur un hébergeur qui ne fait tourner qu'un seul service (ex: Railway sur
  // le plan actuel), il n'y a personne d'autre pour exécuter `npm run cron` :
  // sans ce démarrage ici, le catalogue de deals reste vide en permanence.
  // Activé explicitement (ENABLE_CRON=true) pour ne jamais consommer le
  // quota SerpApi par surprise en local/dev.
  if (process.env.ENABLE_CRON === "true") {
    require("./cron").startCron();
  }
}

module.exports = app;
