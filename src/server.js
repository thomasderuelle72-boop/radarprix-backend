// server.js — API RadarPrix. Ne parle jamais directement au navigateur
// des visiteurs à SerpApi : la clé API reste ici, côté serveur, secrète.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { resolveDirectLink } = require("./serpapi");
const { fetchLiveOffers } = require("./fetchOffers");
const {
  analyzeOffers, filterRelevantOffers, separerOffres,
  isAccessoryTitle, isUsedOrRefurbishedTitle, titleMatchesQuery,
} = require("./algorithm");
const { enregistrerDetections, enregistrerReconditionne } = require("./detections");
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
  listScanRuns, etatPersistance,
  sourceHealth,
  listEmailLog,
  emailStats,
  reglagesDetailles,
  definirReglage,
  listBlacklist,
  ajouterBlacklist,
  retirerBlacklist,
  offreRejetee,
  rejeterOffre,
  listRejets,
  annulerRejet,
  listCatalogItems,
  ajouterCatalogItem,
  basculerCatalogItem,
  supprimerCatalogItem,
  listUsersAdmin,
  userAdminSheet,
  seriesQuotidiennes,
  membresActifs,
  exportMembres,
  exportDeals,
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
  fermerBase,
} = require("./db");
const { randomProductFor, allProducts: allCatalogProducts } = require("./catalog");
const { runCatalogBatch } = require("./scanBatch");
const {
  listDeals: listDealsUnifies, statsDeals, getDeal: getDealUnifie,
  publierDeal, depublierDeal, TYPES_DEAL,
} = require("./dealsStore");
const { collecterTout } = require("./sources");
const {
  ajouterUrl: ajouterUrlSurveillee,
  retirerUrl: retirerUrlSurveillee,
  listerUrls: listerUrlsSurveillees,
  surveiller: surveillerFiches,
} = require("./watch");
const { indicateurs, manquees, noterDeal, ingererVeriteTerrain } = require("./mesure");
const { classement: classementMarchands } = require("./reputation");
const { hashPassword, verifyPassword, generateToken, requireAuth, optionalAuth, requireAdmin, isDesignatedAdminEmail, isValidEmail } = require("./auth");
const { hotScore } = require("./ranking");
const { calculerBadges, prochainsBadges } = require("./badges");
const { validerTexte, limiterFrequence, refuserDoublon } = require("./moderation");

const app = express();

/* Railway sert le backend derrière son propre répartiteur de charge. Sans
   ce réglage, req.ip vaut l'adresse du répartiteur pour TOUS les visiteurs :
   le freinage par IP des routes d'authentification mettrait alors tout le
   monde dans le même compteur, et un seul attaquant bloquerait le site
   entier. On ne fait confiance qu'au premier maillon (le répartiteur), pas
   à une chaîne d'en-têtes X-Forwarded-For que n'importe qui peut forger. */
app.set("trust proxy", 1);

/* ── En-têtes de sécurité ─────────────────────────────────────────
   Sans eux, le site pouvait être chargé dans une iframe invisible chez un
   tiers pour détourner les clics d'un membre connecté, et rien n'interdisait
   au navigateur de deviner le type des réponses.

   La politique de sécurité du contenu reste désactivée pour l'instant : le
   frontend pose ses styles en ligne, une CSP stricte le casserait d'un bloc.
   C'est un chantier à part, à mener en mode rapport avant d'appliquer. Tout
   le reste d'helmet s'applique.

   crossOriginResourcePolicy est ouvert parce que l'API est appelée depuis un
   domaine différent du sien (radarprix.fr → Railway) : la valeur par défaut
   d'helmet bloquerait ces réponses.
   ────────────────────────────────────────────────────────────────── */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

/* ── Origines autorisées ──────────────────────────────────────────
   `cors()` sans argument autorise n'importe quel site à appeler cette API
   depuis le navigateur d'un visiteur connecté. Tant que le site n'avait pas
   d'adresse stable, restreindre n'était pas praticable ; maintenant qu'il y
   en a une, la liste se ferme.

   Trois familles restent acceptées :
     - les domaines du site, en apex et en www, en .fr comme en .com ;
     - les déploiements Vercel (production et prévisualisations, dont le
       sous-domaine est tiré au hasard à chaque commit — d'où le motif) ;
     - le développement local.

   CORS_ORIGINS (séparées par des virgules) remplace entièrement cette liste
   si elle est définie, pour ajouter un domaine sans redéployer le code.
   ────────────────────────────────────────────────────────────────── */
const ORIGINES_PAR_DEFAUT = [
  "https://radarprix.fr",
  "https://www.radarprix.fr",
  "https://radarprix.com",
  "https://www.radarprix.com",
  "https://radarprix-frontend.vercel.app",
];
const MOTIF_PREVISUALISATION_VERCEL = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;
const MOTIF_LOCAL = /^http:\/\/localhost(:\d+)?$/i;

const originesConfigurees = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const originesAutorisees = originesConfigurees.length > 0 ? originesConfigurees : ORIGINES_PAR_DEFAUT;

function origineAutorisee(origin) {
  // Pas d'en-tête Origin : appel hors navigateur (curl, sonde de santé de
  // l'hébergeur, appel serveur à serveur). Ces requêtes ne relèvent pas du
  // CORS et ne doivent pas être refusées ici, sous peine de faire échouer
  // les vérifications de santé de Railway.
  if (!origin) return true;
  if (originesAutorisees.includes(origin)) return true;
  // Les prévisualisations ne sont ouvertes que si aucune liste explicite
  // n'a été configurée : définir CORS_ORIGINS doit vraiment tout fermer.
  if (originesConfigurees.length === 0 && MOTIF_PREVISUALISATION_VERCEL.test(origin)) return true;
  return MOTIF_LOCAL.test(origin);
}

app.use(
  cors({
    origin(origin, callback) {
      if (origineAutorisee(origin)) return callback(null, true);
      // On refuse le partage sans lever d'erreur : le navigateur bloquera
      // la lecture de la réponse, ce qui est le comportement voulu, alors
      // qu'une exception ferait remonter une 500 dans les journaux à chaque
      // robot de passage.
      callback(null, false);
    },
  })
);
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
  // Le reconditionné part vers sa propre section plutôt qu'à la poubelle.
  const { neuf, reconditionne } = separerOffres(rawOffers, query);
  insertSnapshots(query.toLowerCase(), category, [...neuf, ...reconditionne]);

  const analysees = analyzeOffers(neuf);
  // Les anomalies alimentent le flux unifié au passage : une recherche à la
  // demande enrichit le site pour tout le monde, au lieu de ne servir que
  // son auteur.
  enregistrerDetections(category, analysees);
  enregistrerReconditionne(category, reconditionne);

  const analyzed = analysees
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
    // Les anomalies écartées à la main par la modération ne sont plus
    // publiées : un faux positif visible en ligne devait pouvoir être retiré
    // sans attendre un correctif de l'algorithme.
    const analyzed = analyzeOffers(relevant)
      .filter((o) => o.verdict !== "normal")
      .filter((o) => !offreRejetee(o));
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

// ── Flux unifié des bons plans ──────────────────────────────────
// GET /api/feed?type=gratuit&category=gaming&page=1
//
// Sert les quatre détecteurs à travers une seule route : anomalies de prix
// (D3), promotions et codes promo (D1), gratuit (D2). Simple lecture
// paginée d'une table déjà calculée — contrairement à /api/deals qui
// réanalyse tout à chaque visiteur (voir dealsStore).
app.get("/api/feed", (req, res) => {
  const { type, category, detector } = req.query;
  if (type && !TYPES_DEAL.includes(type)) {
    return res.status(400).json({ error: `Type inconnu. Attendus : ${TYPES_DEAL.join(", ")}.` });
  }
  res.json(
    listDealsUnifies({
      type: type || null,
      category: category || "tout",
      detector: detector || null,
      page: parseInt(req.query.page, 10) || 1,
      pageSize: parseInt(req.query.pageSize, 10) || 20,
    })
  );
});

// GET /api/feed/occasion — section dédiée au reconditionné et à l'occasion.
// Séparée du flux principal par choix : une offre reconditionnée est
// légitimement moins chère qu'un produit neuf, la mélanger au reste
// reviendrait à présenter en permanence de fausses bonnes affaires.
app.get("/api/feed/occasion", (req, res) => {
  res.json(
    listDealsUnifies({
      itemCondition: req.query.etat === "occasion" ? "occasion" : "reconditionne",
      category: req.query.category || "tout",
      page: parseInt(req.query.page, 10) || 1,
      pageSize: parseInt(req.query.pageSize, 10) || 20,
    })
  );
});

// GET /api/feed/types — ce que le front peut proposer comme filtres, sans
// avoir à dupliquer la liste des types côté client.
app.get("/api/feed/types", (req, res) => res.json({ types: TYPES_DEAL }));

// ── Mesure : les deux chiffres qui pilotent le réglage ──────────
// Précision (parmi ce qu'on publie, quelle part est fausse) et rappel (parmi
// les vraies erreurs de prix, quelle part on trouve). Sans eux, les seuils du
// détecteur ne peuvent être ajustés qu'à l'intuition.
app.get("/api/admin/indicateurs", requireAuth, requireModerator, (req, res) => {
  res.json(indicateurs({ jours: parseInt(req.query.jours, 10) || 30 }));
});

// Les erreurs de prix connues que RadarPrix n'a PAS vues : la liste de
// travail la plus utile du tableau de bord.
app.get("/api/admin/manquees", requireAuth, requireModerator, (req, res) => {
  res.json({ manquees: manquees({ limit: parseInt(req.query.limit, 10) || 50 }) });
});

// Jugement d'un modérateur sur un deal publié automatiquement. C'est cette
// étiquette qui alimente à la fois la précision et la réputation marchand.
app.post("/api/admin/feed/:id/juger", requireAuth, requireModerator, (req, res) => {
  const deal = getDealUnifie(parseInt(req.params.id, 10));
  if (!deal) return res.status(404).json({ error: "Deal introuvable." });
  try {
    noterDeal(deal.id, req.body?.verdict, { motif: req.body?.motif || null, userId: req.user.sub });
    // Un faux positif quitte le flux immédiatement : le signaler sans le
    // retirer laisserait le membre tomber dessus malgré tout.
    if (req.body?.verdict === "faux_positif") depublierDeal(deal.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/admin/verite-terrain", requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await ingererVeriteTerrain());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/admin/marchands", requireAuth, requireModerator, (req, res) => {
  res.json({ marchands: classementMarchands({ limit: parseInt(req.query.limit, 10) || 50 }) });
});

// ── Surveillance des fiches marchandes (détecteur D3) ───────────
// C'est ce qui remplace la recherche large : au lieu d'interroger un
// agrégateur une fois toutes les seize heures, on relit des fiches précises
// toutes les quinze minutes, pour un coût en bande passante.
app.get("/api/admin/watch", requireAuth, requireModerator, (req, res) => {
  res.json({ urls: listerUrlsSurveillees({ actives: req.query.toutes !== "1" }) });
});

app.post("/api/admin/watch", requireAuth, requireAdmin, (req, res) => {
  const { url, label, merchant, category, produit } = req.body || {};
  if (!url) return res.status(400).json({ error: "Paramètre 'url' requis." });
  try {
    res.json({ url: ajouterUrlSurveillee({ url, label, merchant, category, produit }) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/admin/watch/:id", requireAuth, requireAdmin, (req, res) => {
  retirerUrlSurveillee(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

app.post("/api/admin/watch/run", requireAuth, requireAdmin, async (req, res) => {
  try {
    const resultats = await surveillerFiches({ taille: parseInt(req.body?.taille, 10) || undefined });
    res.json({ verifiees: resultats.length, resultats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Administration du flux ──────────────────────────────────────
app.post("/api/admin/collecte", requireAuth, requireAdmin, async (req, res) => {
  try {
    const resultats = await collecterTout({ detecteur: req.body?.detecteur || null });
    res.json({ resultats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/feed/stats", requireAuth, requireModerator, (req, res) => {
  res.json({ stats: statsDeals() });
});

// Un deal collecté automatiquement mais jugé sans intérêt doit pouvoir être
// retiré du flux sans attendre un correctif du score de désirabilité.
app.post("/api/admin/feed/:id/publier", requireAuth, requireModerator, (req, res) => {
  const deal = getDealUnifie(parseInt(req.params.id, 10));
  if (!deal) return res.status(404).json({ error: "Deal introuvable." });
  publierDeal(deal.id);
  res.json({ ok: true, deal: getDealUnifie(deal.id) });
});

app.delete("/api/admin/feed/:id/publier", requireAuth, requireModerator, (req, res) => {
  const deal = getDealUnifie(parseInt(req.params.id, 10));
  if (!deal) return res.status(404).json({ error: "Deal introuvable." });
  depublierDeal(deal.id);
  res.json({ ok: true, deal: getDealUnifie(deal.id) });
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
/* ── Freinage des routes d'authentification ───────────────────────
   `limiterFrequence` protégeait déjà les commentaires, le salon et les
   messages privés — mais pas la connexion, la seule route qu'un attaquant
   ait intérêt à marteler. Sans elle, un script pouvait essayer des milliers
   de mots de passe, ou créer des comptes en masse.

   Deux différences avec les autres usages :
     - la clé est l'adresse IP et non l'identifiant du membre, qui n'existe
       pas encore au moment où l'on se connecte ;
     - la fenêtre est large (10 tentatives par quart d'heure) : il s'agit
       d'arrêter une machine, pas de gêner quelqu'un qui cherche son mot de
       passe de bonne foi.

   Le hachage bcrypt rend déjà chaque tentative lente — ce qui, sans frein,
   se retourne contre le serveur : chaque essai lui coûte du processeur.
   ────────────────────────────────────────────────────────────────── */
function freinerAuth(action, max, fenetreMs) {
  return (req, res, next) => {
    // `trust proxy` est actif (voir plus bas) : req.ip porte alors l'adresse
    // réelle du client et non celle du répartiteur de charge.
    const debit = limiterFrequence(`ip:${req.ip}`, action, max, fenetreMs);
    if (!debit.ok) {
      return res.status(429).json({
        error: "Trop de tentatives depuis cette adresse. Réessaie dans quelques minutes.",
      });
    }
    next();
  };
}

app.post("/api/auth/register", freinerAuth("register", 5, 900000), async (req, res) => {
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
app.post("/api/auth/login", freinerAuth("login", 10, 900000), async (req, res) => {
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
    // Où la base est écrite et ce qu'elle contient. C'est la réponse à
    // « est-ce que les comptes vont survivre au prochain déploiement ? »,
    // qui exigeait jusqu'ici d'aller lire les journaux de l'hébergeur.
    persistance: etatPersistance(),
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


// ── Qualité de la détection ──────────────────────────────────────

// GET /api/admin/settings — réglages de l'algorithme, avec bornes et valeur d'origine.
app.get("/api/admin/settings", requireAuth, requireAdmin, (req, res) => {
  res.json({ items: reglagesDetailles() });
});

// PATCH /api/admin/settings  { cle, valeur }  (valeur null = valeur d'origine)
app.patch("/api/admin/settings", requireAuth, requireAdmin, (req, res) => {
  const r = definirReglage(req.user.sub, req.body?.cle, req.body?.valeur);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, valeur: r.valeur, items: reglagesDetailles() });
});

// GET /api/admin/blacklist
app.get("/api/admin/blacklist", requireAuth, requireModerator, (req, res) => {
  res.json({ items: listBlacklist() });
});

// POST /api/admin/blacklist  { type: "marchand"|"motif", valeur, note? }
app.post("/api/admin/blacklist", requireAuth, requireModerator, (req, res) => {
  const r = ajouterBlacklist(req.user.sub, req.body?.type, req.body?.valeur, req.body?.note);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json({ ok: true, items: listBlacklist() });
});

// DELETE /api/admin/blacklist/:id
app.delete("/api/admin/blacklist/:id", requireAuth, requireModerator, (req, res) => {
  const r = retirerBlacklist(req.user.sub, parseInt(req.params.id, 10));
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true, items: listBlacklist() });
});

// POST /api/admin/rejects  { name, seller, price, motif? } — écarte une anomalie.
app.post("/api/admin/rejects", requireAuth, requireModerator, (req, res) => {
  const r = rejeterOffre(req.user.sub, req.body || {});
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json({ ok: true, deja: Boolean(r.deja) });
});

// GET /api/admin/rejects
app.get("/api/admin/rejects", requireAuth, requireModerator, (req, res) => {
  res.json({ items: listRejets() });
});

// DELETE /api/admin/rejects/:id — remet l'anomalie en circulation.
app.delete("/api/admin/rejects/:id", requireAuth, requireModerator, (req, res) => {
  const r = annulerRejet(req.user.sub, parseInt(req.params.id, 10));
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true });
});

// ── Catalogue ────────────────────────────────────────────────────

// GET /api/admin/catalog — produits du fichier + produits ajoutés à la main.
app.get("/api/admin/catalog", requireAuth, requireAdmin, (req, res) => {
  res.json({
    // Le fichier catalog.js reste la référence et n'est pas modifiable
    // depuis le site : le distinguer évite de croire qu'on peut y toucher.
    fichier: allCatalogProducts(),
    ajoutes: listCatalogItems(),
  });
});

// POST /api/admin/catalog  { name, category }
app.post("/api/admin/catalog", requireAuth, requireAdmin, (req, res) => {
  const r = ajouterCatalogItem(req.user.sub, req.body?.name, req.body?.category);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json({ ok: true, ajoutes: listCatalogItems() });
});

// PATCH /api/admin/catalog/:id  { actif }
app.patch("/api/admin/catalog/:id", requireAuth, requireAdmin, (req, res) => {
  const r = basculerCatalogItem(req.user.sub, parseInt(req.params.id, 10), Boolean(req.body?.actif));
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true, ajoutes: listCatalogItems() });
});

// DELETE /api/admin/catalog/:id
app.delete("/api/admin/catalog/:id", requireAuth, requireAdmin, (req, res) => {
  const r = supprimerCatalogItem(req.user.sub, parseInt(req.params.id, 10));
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true, ajoutes: listCatalogItems() });
});


// ── Membres et statistiques ──────────────────────────────────────

/**
 * Met une valeur au format CSV : guillemets doublés, champ entouré si
 * nécessaire. Sans ça, un titre de deal contenant une virgule ou un
 * point-virgule décalerait toutes les colonnes suivantes du fichier.
 */
function champCsv(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function versCsv(lignes) {
  if (lignes.length === 0) return "";
  const colonnes = Object.keys(lignes[0]);
  const corps = lignes.map((l) => colonnes.map((c) => champCsv(l[c])).join(";"));
  // Point-virgule et BOM : c'est ce qu'attend Excel en français, sinon les
  // accents sortent en charabia et tout tient dans une seule colonne.
  return "\uFEFF" + [colonnes.join(";"), ...corps].join("\r\n");
}

// GET /api/admin/members?recherche=&filtre=&tri=&page=
app.get("/api/admin/members", requireAuth, requireModerator, (req, res) => {
  const pageSize = Math.min(100, Math.max(10, parseInt(req.query.pageSize, 10) || 40));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const items = listUsersAdmin({
    recherche: req.query.recherche || "",
    filtre: req.query.filtre || "tous",
    tri: req.query.tri || "recent",
    limit: pageSize + 1, // une de plus pour savoir s'il reste une page
    offset: (page - 1) * pageSize,
  });
  res.json({ items: items.slice(0, pageSize), hasMore: items.length > pageSize, page, pageSize });
});

// GET /api/admin/members/:id — fiche complète.
app.get("/api/admin/members/:id", requireAuth, requireModerator, (req, res) => {
  const fiche = userAdminSheet(parseInt(req.params.id, 10));
  if (!fiche) return res.status(404).json({ error: "Membre introuvable." });
  res.json(fiche);
});

// GET /api/admin/activity?jours=30 — séries quotidiennes pour les courbes.
app.get("/api/admin/activity", requireAuth, requireModerator, (req, res) => {
  const jours = Math.min(90, Math.max(7, parseInt(req.query.jours, 10) || 30));
  res.json({
    jours,
    series: seriesQuotidiennes(jours),
    membresActifs: membresActifs(jours),
    totalMembres: countUsers(),
  });
});

// GET /api/admin/export/:quoi.csv  (membres | deals)
app.get("/api/admin/export/:quoi", requireAuth, requireAdmin, (req, res) => {
  const quoi = String(req.params.quoi).replace(/\.csv$/, "");
  const sources = { membres: exportMembres, deals: exportDeals };
  if (!sources[quoi]) return res.status(404).json({ error: "Export inconnu." });

  const csv = versCsv(sources[quoi]());
  const jour = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="radarprix-${quoi}-${jour}.csv"`);
  journaliser(req.user.sub, "export", { detail: quoi });
  res.send(csv);
});

app.get("/api/admin/stats", requireAuth, requireModerator, (req, res) => {
  res.json({
    totalUsers: countUsers(),
    totalScans: countScans(),
    topProducts: topScannedProducts(10),
    // Deux chiffres qui appellent une action, là où les deux compteurs
    // d'origine ne disaient rien de ce qu'il y avait à faire.
    signalementsOuverts: countOpenReports(),
    membresActifs30j: membresActifs(30),
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
  const serveur = app.listen(PORT, () => console.log(`RadarPrix backend en écoute sur le port ${PORT}`));

  // Sur un hébergeur qui ne fait tourner qu'un seul service (ex: Railway sur
  // le plan actuel), il n'y a personne d'autre pour exécuter `npm run cron` :
  // sans ce démarrage ici, le catalogue de deals reste vide en permanence.
  // Activé explicitement (ENABLE_CRON=true) pour ne jamais consommer le
  // quota SerpApi par surprise en local/dev.
  if (process.env.ENABLE_CRON === "true") {
    require("./cron").startCron();
  }

  /* ── Arrêt propre ───────────────────────────────────────────────
     À chaque redéploiement, l'hébergeur envoie SIGTERM puis tue le
     processus. Sans ce gestionnaire, les requêtes en cours étaient coupées
     net et le journal WAL de SQLite restait non consolidé — un fichier de
     base laissé dans un état qui, à la longue, finit par coûter cher.

     L'ordre compte : on cesse d'accepter des connexions, on laisse finir
     celles en cours, PUIS on consolide et on ferme la base. Fermer la base
     d'abord ferait échouer les requêtes encore en vol.

     Le délai de grâce évite qu'une connexion maintenue ouverte (requête
     longue, client qui ne raccroche pas) empêche indéfiniment l'arrêt :
     l'hébergeur, lui, ne patientera pas.
     ────────────────────────────────────────────────────────────── */
  let arretEnCours = false;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      if (arretEnCours) return; // un second signal ne relance pas la séquence
      arretEnCours = true;
      console.log(`[${signal}] arrêt demandé — fermeture en cours…`);

      let dejaFermee = false;
      const terminer = () => {
        if (dejaFermee) return; // le délai de grâce et serveur.close() peuvent tous deux arriver
        dejaFermee = true;
        try {
          fermerBase();
          console.log("Base consolidée et fermée proprement.");
        } catch (e) {
          console.error("Fermeture de la base en échec :", e.message);
        }
        process.exit(0);
      };

      serveur.close(terminer);
      setTimeout(() => {
        console.warn("Délai de grâce dépassé — fermeture forcée.");
        terminer();
      }, 8000).unref();
    });
  }
}

module.exports = app;
