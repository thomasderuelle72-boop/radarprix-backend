// server.js — API RadarPrix. Ne parle jamais directement au navigateur
// des visiteurs à SerpApi : la clé API reste ici, côté serveur, secrète.
require("./env");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
// analyzeOffers reste le seul emprunt à l'algorithme : /api/latest relit les
// relevés déjà en base pour en tirer un prix de référence. Rien ici ne va
// plus chercher d'offres — c'est justement ce qui a été retiré.
const { analyzeOffers } = require("./algorithm");
const {
  latestSnapshots,
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
  TYPES_CONTENU,
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
  epinglerDeal, etatPersistance,
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
  listScanRuns,
  fermerBase,
} = require("./db");
const {
  sendMessage, listPublicMessages, listConversation,
  markConversationRead, countUnreadMessages, listConversationsFor,
  masquerConversation, supprimerMessage, marquerConversationNonLue,
} = require("./messagerie");
const {
  listForumCategories, getForumCategoryBySlug, listForumThreads,
  getForumThread, createForumThread, listForumReplies, addForumReply,
} = require("./forum");
const {
  listDeals: listDealsUnifies,   TYPES_DEAL,
} = require("./dealsStore");
const { domainePourLogo } = require("./marchands");
const {
  sonderMarchands, inspecterPage, inspecterMarchand, purgerFichesNonProduits,
} = require("./catalogue");
const identites = require("./identites");
const telegram = require("./telegram");

/* Les enseignes dont RadarPrix parcourt déjà le catalogue par sitemap. Si
   l'une d'elles est sur Awin AVEC un flux produits, elle devient bien plus
   intéressante par ce canal : lien profond, EAN, prix conseillé. */
const CATALOGUES_MAISON = ["LDLC", "JouéClub", "Electro Dépôt", "Nature & Découvertes", "Ikea"];
const { reinitialiser, apercu } = require("./reinitialisation");
const { etatRadar } = require("./radarEtat");
const { compterNonLues, listerNotifications, marquerLues } = require("./notifications");
const { hashPassword, verifyPassword, generateToken, requireAuth, optionalAuth, requireAdmin, isDesignatedAdminEmail, isValidEmail } = require("./auth");
const { hotScore } = require("./ranking");
const { calculerBadges, prochainsBadges } = require("./badges");
const { validerTexte, limiterFrequence, refuserDoublon } = require("./moderation");
const { diagnostic: diagnosticAwin } = require("./awin");
const {
  listTargets,
  getTarget,
  addTarget,
  updateTarget,
  deleteTarget,
  semerCibles,
  desactiverCiblesMortes,
  desactiverCataloguesAbandonnes,
  reparerLiensAgregateur,
  retirerOffresMalNommees,
  retirerRemisesFabriquees,
  retirerOffresSansAvantage,
  lancerScan,
  etatCollecte,
} = require("./collect");

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

/**
 * Porte d'entrée du déclencheur de scan : le panneau d'administration
 * passe par son jeton, le planificateur de l'hébergeur (Railway cron…)
 * par un jeton dédié dans l'en-tête x-scan-token.
 *
 * La comparaison se fait en temps constant : sans SCAN_TOKEN défini, seule
 * la voie administrateur reste ouverte.
 */
function autoriserScan(req, res, next) {
  const attendu = process.env.SCAN_TOKEN;
  if (attendu) {
    const fourni = String(req.headers["x-scan-token"] || "");
    const a = Buffer.from(fourni);
    const b = Buffer.from(attendu);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  requireAuth(req, res, next);
}

// GET /api/deals?category=gaming&page=1&pageSize=15&q=pc
// Sert les anomalies déjà détectées, en lecture paginée directe.
//
// Cette route recalculait auparavant TOUT à chaque visite : pour chaque
// produit du catalogue elle refiltrait les offres puis les réanalysait, et
// analyzeOffers interroge la base une fois par offre pour retrouver son
// historique — soit plusieurs centaines de requêtes SQL par chargement de
// page. Invisible sur un petit catalogue avec un seul visiteur, c'était le
// premier plafond de charge du site.
//
// Le calcul a désormais lieu une fois par scan (voir detections.js, appelé
// par scanBatch) et non une fois par visiteur. La forme de la réponse est
// inchangée : le frontend consomme les mêmes champs qu'avant.
//
// Le paramètre optionnel "q" filtre par mot-clé sur des anomalies DÉJÀ
// qualifiées individuellement — chacune comparée à ses propres pairs au
// moment du scan. Une recherche large comme "pc" parcourt donc ce qui a été
// détecté sur des PC sans jamais comparer entre eux des produits différents.
app.get("/api/deals", (req, res) => {
  const category = req.query.category || "tout";
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 15));

  const { total, hasMore, items } = listDealsUnifies({
    // D3 seulement : les promotions d'affiliation (D1) et les jeux offerts
    // (D2) ont leur propre flux. Cette route reste celle des anomalies de
    // prix mesurées par RadarPrix.
    detector: "D3",
    category,
    q: req.query.q || null,
    page,
    pageSize,
  });

  res.json({
    category,
    page,
    pageSize,
    total,
    hasMore,
    items: items.map(enFormeHeritee),
  });
});

/**
 * Traduit un deal du flux unifié vers les noms de champs qu'attend le
 * frontend historique (DealCard, ProductDetailView...).
 *
 * Renommer côté client aurait touché une dizaine de composants pour un gain
 * nul : la correspondance vit ici, à la frontière, et le stockage garde ses
 * propres noms.
 */
function enFormeHeritee(d) {
  return {
    id: d.id,
    name: d.title,
    price: d.price,
    seller: d.merchant,
    url: d.url,
    img: d.imageUrl,
    refPrice: d.referencePrice,
    pct: d.discountPct,
    // Le stockage distingue « erreur » et « promo » ; le frontend parle de
    // « erreur » et « deal » depuis l'origine.
    verdict: d.type === "erreur" ? "erreur" : "deal",
    score: d.score,
    confidence: d.confidence,
    allTimeLow: Boolean(d.payload && d.payload.allTimeLow),
    // « mesure » : référence observée entre marchands par RadarPrix.
    // « flux » : prix barré annoncé par la source. L'interface doit
    // pouvoir les distinguer, sous peine de présenter l'argument
    // commercial d'un vendeur comme une mesure indépendante.
    refSource: (d.payload && d.payload.refSource) || null,
    // « marche » : plusieurs marchands ont pratiqué ce prix.
    // « marchand » : c'est le passé de cette seule enseigne.
    baseReference: (d.payload && d.payload.baseReference) || null,
    marchandsComparés: (d.payload && d.payload.marchandsComparés) || 0,
    itemCondition: d.itemCondition || "neuf",
    // Le code à copier. Le flux unifié l'affichait déjà ; la page « Deals »
    // ne le recevait même pas, alors que c'est elle que l'onglet mobile ouvre.
    voucherCode: d.voucherCode || null,
    // Ce que la fiche du marchand déclare en plus du prix : de quoi rendre
    // une carte informative plutôt qu'une ligne de tarif.
    description: d.description || null,
    caracteristiques: (d.payload && d.payload.caracteristiques) || null,
    startsAt: d.startsAt || null,
    expiresAt: d.expiresAt || null,
    // Ce que le lien ouvre : "produit", "recherche" ou "marchand". La carte
    // doit promettre ce qu'elle tient.
    lienType: (d.payload && d.payload.lienType) || null,
    // Les autres marchands du même article, et le prix le plus bas connu.
    autresMarchands: d.autresMarchands || [],
    meilleurPrix: d.meilleurPrix ?? d.price,
    nbMarchands: d.nbMarchands ?? (d.merchant ? 1 : 0),
    // Domaine de l'enseigne, pour son logo.
    marchandDomaine: domainePourLogo({
      domaine: d.payload && d.payload.marchandDomaine,
      url: d.url,
      marchand: d.merchant,
    }),
  };
}

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

// ── Canal Telegram ───────────────────────────────────────────────
// Lecture réservée à la modération, action réservée à l'administration :
// publier sur un canal public n'est pas un geste de modération.

app.get("/api/admin/telegram", requireAuth, requireModerator, (req, res) => {
  res.json({
    etat: telegram.etat(),
    derniers: telegram.derniersPosts(20),
    enAttente: telegram.candidats(20),
  });
});

app.post("/api/admin/telegram/publier/:id", requireAuth, requireAdmin, async (req, res) => {
  const r = await telegram.publierMaintenant(parseInt(req.params.id, 10));
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r);
});

app.post("/api/admin/telegram/ignorer/:id", requireAuth, requireAdmin, (req, res) => {
  const r = telegram.ignorer(parseInt(req.params.id, 10));
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r);
});

app.get("/api/admin/reinitialiser", requireAuth, requireAdmin, (req, res) => {
  res.json({ apercu: apercu() });
});

// Remise à zéro du contenu produit par les détecteurs. Les comptes, le forum
// et la messagerie ne sont jamais touchés : ce sont les seules données que
// personne ne peut régénérer.
app.post("/api/admin/reinitialiser", requireAuth, requireAdmin, (req, res) => {
  // Confirmation explicite : une route qui vide des tables ne doit pas
  // pouvoir être déclenchée par un clic mal placé ni par un appel recopié.
  if (req.body?.confirmation !== "REINITIALISER") {
    return res.status(400).json({
      error: 'Confirmation requise : envoie {"confirmation":"REINITIALISER"}.',
      apercu: apercu(),
    });
  }
  try {
    res.json({ efface: reinitialiser({ garderHistorique: Boolean(req.body?.garderHistorique) }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/latest", (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "Paramètre 'query' requis." });
  // Sans le .toLowerCase() d'origine : la colonne `query` garde la casse de
  // la cible (« Catalogue Electro Dépôt »), la comparaison en minuscules ne
  // remontait donc jamais rien pour un catalogue.
  const rows = latestSnapshots(query);
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

/* GET /api/auth/fournisseurs — quels boutons le site doit-il afficher ?

   Le frontend ne devine pas : il demande. Un bouton « Continuer avec Apple »
   affiché alors que rien n'est configuré mène à une erreur incompréhensible
   pour le visiteur, et l'identifiant client n'a rien à faire en dur dans le
   code du navigateur. */
app.get("/api/auth/fournisseurs", (req, res) => {
  res.json({
    fournisseurs: identites.fournisseursActifs().map((f) => ({
      id: f,
      nom: identites.FOURNISSEURS[f].nom,
      // L'identifiant client est PUBLIC par construction — le navigateur doit
      // le présenter au fournisseur. Ce n'est pas un secret, contrairement au
      // « client secret » qu'on n'utilise pas et qui, lui, ne sortira jamais
      // d'ici.
      clientId: identites.FOURNISSEURS[f].clientId(),
    })),
  });
});

/* POST /api/auth/oidc  { fournisseur, jeton }

   Une seule route pour Google et Apple : ils parlent le même langage, et
   deux routes jumelles se seraient désynchronisées à la première correction.

   LA RÈGLE DE RATTACHEMENT, qui est la partie délicate.

   Trois cas, dans cet ordre :

   1. On connaît déjà cette identité (même fournisseur, même sujet) → on
      ouvre la session de son compte. Le « sujet » est l'identifiant stable
      du fournisseur ; il ne change pas si la personne change d'email.

   2. Aucune identité connue, mais le fournisseur affirme une adresse email
      VÉRIFIÉE qui correspond à un compte existant → on rattache. C'est ce
      qui évite les comptes en double, et c'est légitime : Google et Apple
      ont prouvé que la personne contrôle cette adresse.

   3. Sinon → nouveau compte.

   Le point 2 exige `email_verified`. Sans ce contrôle, un fournisseur
   complaisant — ou un compte dont l'email n'a jamais été prouvé — permettrait
   de réclamer le compte de quelqu'un d'autre en déclarant son adresse. C'est
   la faille classique de ce mécanisme, et elle tient en une ligne. */
app.post("/api/auth/oidc", freinerAuth("oidc", 20, 900000), async (req, res) => {
  const fournisseur = String(req.body?.fournisseur || "").trim().toLowerCase();
  const jeton = String(req.body?.jeton || "").trim();
  if (!identites.FOURNISSEURS[fournisseur]) {
    return res.status(400).json({ error: "Fournisseur inconnu." });
  }
  if (!identites.configure(fournisseur)) {
    return res.status(503).json({ error: `La connexion ${identites.FOURNISSEURS[fournisseur].nom} n'est pas activée.` });
  }
  if (!jeton) return res.status(400).json({ error: "Jeton manquant." });

  let atteste;
  try {
    atteste = await identites.verifierJeton(fournisseur, jeton);
  } catch (e) {
    // On ne renvoie pas le détail : il ne renseignerait que celui qui essaie
    // de forger un jeton. Le journal, lui, garde tout.
    console.warn(`[auth] jeton ${fournisseur} refusé : ${e.message}`);
    return res.status(401).json({ error: "Connexion refusée par le fournisseur." });
  }

  try {
    let userId = identites.identiteDe(fournisseur, atteste.sujet)?.user_id || null;

    if (!userId && atteste.email && atteste.emailVerifie) {
      const existant = findUserByEmail(atteste.email);
      if (existant) userId = existant.id;
    }

    if (!userId) {
      /* Un compte sans mot de passe utilisable. On hache une valeur aléatoire
         plutôt que de laisser le champ vide : la colonne est NOT NULL, et
         surtout une empreinte bcrypt d'un secret que personne ne connaît ne
         peut jamais être devinée. Le membre pourra se donner un mot de passe
         plus tard s'il le souhaite. */
      const email = atteste.email || `${fournisseur}-${atteste.sujet}@identite.radarprix.fr`;
      if (findUserByEmail(email)) {
        return res.status(409).json({ error: "Un compte existe déjà avec cet email." });
      }
      const secret = require("node:crypto").randomBytes(32).toString("hex");
      const cree = createUser(email, await hashPassword(secret));
      userId = cree.id;
    }

    identites.lier(fournisseur, atteste.sujet, userId, atteste.email);

    const complet = findUserById(userId);
    if (isDesignatedAdminEmail(complet.email)) promoteToAdmin(complet.id);
    const token = generateToken(findUserById(userId));
    res.json({ token, user: findUserById(userId) });
  } catch (e) {
    console.error(`[auth] connexion ${fournisseur} impossible : ${e.message}`);
    res.status(500).json({ error: "Connexion impossible." });
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
    // Troisième forme : un avatar de la panoplie du site, stocké comme un
    // jeton « rp:motif-teinte » et redessiné à l'affichage. On ne valide que
    // la forme : la liste des motifs vit dans le frontend, et la dupliquer
    // ici obligerait à déployer les deux côtés pour en ajouter un. Un jeton
    // inconnu retombe proprement sur l'initiale colorée.
    const panoplie = /^rp:[a-z]{2,20}-[a-z]{2,20}$/.test(avatarUrl);
    // Quatrième forme : un chasseur, quatorze indices de couche en base36
    // (voir components/hunters.jsx côté frontend). Comme pour la panoplie,
    // on ne valide que la forme : la liste des pièces vit dans le frontend,
    // et la dupliquer ici obligerait à déployer les deux côtés pour en
    // ajouter une. Un index hors bornes retombe sur l'initiale colorée.
    const chasseur = /^rh:[0-9a-z]{14}$/.test(avatarUrl);
    if (!lien && !integree && !panoplie && !chasseur) {
      return res.status(400).json({ error: "Avatar invalide : choisis-en un dans la galerie, une photo, ou indique un lien http(s)." });
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

// DELETE /api/chat/with/:userId — supprime la conversation POUR SOI.
//
// Les messages ne sont pas effacés : ils appartiennent aussi à l'autre
// membre, qui ne les a pas supprimés. On pose un repère à partir duquel le
// fil redevient vide de ce côté-ci ; si le correspondant écrit à nouveau, la
// conversation repart de son message, sans l'historique masqué.
app.delete("/api/chat/with/:userId", requireAuth, (req, res) => {
  const otherId = parseInt(req.params.userId, 10);
  if (!otherId) return res.status(400).json({ error: "Identifiant invalide." });
  const repere = masquerConversation(req.user.sub, otherId);
  res.json({ ok: true, repere });
});

// POST /api/chat/with/:userId/non-lu — remet la conversation en attente.
app.post("/api/chat/with/:userId/non-lu", requireAuth, (req, res) => {
  const otherId = parseInt(req.params.userId, 10);
  if (!otherId) return res.status(400).json({ error: "Identifiant invalide." });
  const fait = marquerConversationNonLue(req.user.sub, otherId);
  if (!fait) return res.status(400).json({ error: "Aucun message reçu à remettre en attente." });
  res.json({ ok: true });
});

// DELETE /api/chat/message/:id — supprime un message qu'on a envoyé.
// La propriété est vérifiée dans la requête SQL elle-même : deviner
// l'identifiant du message d'un autre ne donne rien.
app.delete("/api/chat/message/:id", requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Identifiant invalide." });
  const supprime = supprimerMessage(req.user.sub, id);
  if (!supprime) return res.status(404).json({ error: "Message introuvable ou non supprimable." });
  res.json({ ok: true });
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

// GET /api/admin/health — l'état de ce qui reste : la base et sa persistance.
//
// Cette route rendait aussi l'état des sources extérieures, du dernier scan
// et des clés d'API. Ces trois-là ne décrivaient plus rien depuis le retrait
// de la machinerie d'acquisition : mieux vaut une réponse courte et vraie
// qu'un tableau de bord qui affiche des zéros.
app.get("/api/admin/health", requireAuth, requireModerator, (req, res) => {
  res.json({
    // Où la base est écrite et ce qu'elle contient. C'est la réponse à
    // « est-ce que les comptes vont survivre au prochain déploiement ? »,
    // qui exigeait jusqu'ici d'aller lire les journaux de l'hébergeur.
    persistance: etatPersistance(),
    // Ce que la détection suit et quand elle a balayé pour la dernière
    // fois — le minimum pour savoir si le radar tourne encore.
    detection: {
      cibles: listTargets({ actives: true }).length,
      dernierScan: listScanRuns(1)[0] || null,
    },
  });
});

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

/* ── Export CSV ──────────────────────────────────────────────────
   Un point-virgule comme séparateur et un BOM en tête : c'est ce qu'attend
   Excel en français. Avec une virgule, tout arrive dans une seule colonne ;
   sans BOM, les accents sortent en charabia. */
function champCsv(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function versCsv(lignes) {
  if (lignes.length === 0) return "";
  const colonnes = Object.keys(lignes[0]);
  const corps = lignes.map((l) => colonnes.map((c) => champCsv(l[c])).join(";"));
  return "\uFEFF" + [colonnes.join(";"), ...corps].join("\r\n");
}

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

// ── Détection : cibles suivies et scans ─────────────────────────
//
// Le nouveau moteur d'acquisition (voir collect.js) : des cibles — un
// produit et de quoi aller le chercher (flux RSS/feed marchand, ou domaines
// pour le scraping Firecrawl) — et un scan qui les passe toutes au crible
// pour publier les anomalies dans le flux public.

// GET /api/admin/targets — les recherches suivies par la détection.
app.get("/api/admin/targets", requireAuth, requireModerator, (req, res) => {
  res.json({ items: listTargets() });
});

// POST /api/admin/targets
//   { query, category?, merchant?, feedUrl?, promoUrl?, catalogueUrl?,
//     awinFeeds?, domains? }
// Au moins une source est requise : une cible sans source ne produirait
// que des échecs à chaque scan. awinFeeds attend des identifiants de flux
// Awin séparés par des virgules — « 12345,67890 ».
app.post("/api/admin/targets", requireAuth, requireAdmin, (req, res) => {
  const r = addTarget(req.body || {});
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json({ target: r.target });
});

// PATCH /api/admin/targets/:id  { active?, category?, merchant?, feedUrl?, domains? }
// Les canaux catalogue et Awin ne se modifient pas ici : ils se posent à la
// création. Seule leur mise en pause passe par « active ».
app.patch("/api/admin/targets/:id", requireAuth, requireAdmin, (req, res) => {
  const r = updateTarget(parseInt(req.params.id, 10), req.body || {});
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ target: r.target });
});

// DELETE /api/admin/targets/:id — retire la cible (les historiques restent).
app.delete("/api/admin/targets/:id", requireAuth, requireAdmin, (req, res) => {
  if (!deleteTarget(parseInt(req.params.id, 10))) {
    return res.status(404).json({ error: "Cible introuvable." });
  }
  res.json({ ok: true });
});

// POST /api/admin/scan  { targetId? } — lance un scan et répond aussitôt :
// le travail continue en arrière-plan et se suit sur GET /api/admin/scan/status.
// Accessible au cron via l'en-tête x-scan-token (voir autoriserScan).
app.post("/api/admin/scan", autoriserScan, (req, res) => {
  const targetId = parseInt(req.body?.targetId, 10) || undefined;
  if (targetId && !getTarget(targetId)) {
    return res.status(404).json({ error: "Cible introuvable." });
  }
  lancerScan({
    userId: req.user ? req.user.sub : null,
    source: req.user ? "manuel" : "cron",
    targetId,
  })
    .then((bilan) =>
      console.log(
        `[scan] #${bilan.runId} : ${bilan.cibles} cible(s), ${bilan.offres} offre(s), ` +
          `${bilan.publies} publiée(s), ${bilan.ignorees} écartée(s), ${bilan.erreurs} erreur(s)`
      )
    )
    .catch((e) => console.error(`[scan] échec : ${e.message}`));
  res.status(202).json({
    demarre: true,
    message: "Scan lancé — suis son avancement sur GET /api/admin/scan/status.",
  });
});

/* POST /api/admin/catalogues/sonde — qui, dans le registre, se laisse lire ?

   Répond aussitôt et travaille en fond, comme le scan : cent vingt-deux
   marchands à sonder prennent de longues minutes. Le résultat part dans le
   journal au fil de l'eau — c'est une mesure qu'on lit, pas une donnée
   qu'on sert.

   Même jeton que le scan : c'est de l'administration, et ça sort du réseau
   en notre nom. */
let sondeEnCours = false;
app.post("/api/admin/catalogues/sonde", autoriserScan, (req, res) => {
  if (sondeEnCours) return res.status(409).json({ error: "Une sonde est déjà en cours." });
  sondeEnCours = true;

  const debut = Date.now();
  let lisibles = 0;
  let sondes = 0;
  sonderMarchands({
    fiches: 3,
    surChaque: (r) => {
      sondes++;
      if (r.lues > 0) lisibles++;
      console.log(
        r.erreur
          ? `[sonde] ${r.nom} : ${r.erreur}`
          : `[sonde] ${r.nom} : ${r.fiches} fiche(s) listée(s), ${r.lues}/${r.essais} lue(s)`
      );
    },
  })
    .then(() =>
      console.log(
        `[sonde] terminée — ${lisibles} marchand(s) lisible(s) sur ${sondes}, ` +
          `en ${Math.round((Date.now() - debut) / 1000)} s.`
      )
    )
    .catch((e) => console.error(`[sonde] échec : ${e.message}`))
    .finally(() => {
      sondeEnCours = false;
    });

  res.status(202).json({ demarre: true, message: "Sonde lancée — le résultat part dans le journal." });
});

/* POST /api/admin/catalogues/inspecte — que contient vraiment cette page ?

   Répond directement, sans passer par le journal : c'est une mesure qu'on
   lit une fois pour décider quoi écrire. Prend une adresse, ou un marchand
   dont on tire une fiche déjà suivie. */
app.post("/api/admin/catalogues/inspecte", autoriserScan, async (req, res) => {
  const url = String(req.body?.url || "").trim();
  const marchand = String(req.body?.marchand || "").trim();
  if (!url && !marchand) {
    return res.status(400).json({ error: "Il faut une adresse http(s) ou un marchand." });
  }
  if (url && !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "Il faut une adresse http(s)." });
  }
  try {
    const extrait = Math.min(4000, parseInt(req.body?.extrait, 10) || 240);
    res.json(marchand ? await inspecterMarchand(marchand) : await inspecterPage(url, { extrait }));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/admin/scan/status — exécutions récentes + santé des canaux de collecte.
app.get("/api/admin/scan/status", requireAuth, requireModerator, (req, res) => {
  res.json({ runs: listScanRuns(20), collecte: etatCollecte() });
});

app.get("/api/radar", (req, res) => {
  try {
    res.json(etatRadar());
  } catch (e) {
    // Un indicateur en panne ne doit jamais empêcher la navigation de
    // s'afficher : le frontend sait se passer de cette réponse.
    res.status(500).json({ error: e.message });
  }
});

/* ── Activité : tout ce qui attend le membre, en un seul appel ──────
   Messages privés et notifications sont deux mécanismes distincts en base,
   mais une seule et même chose pour qui regarde son téléphone : « est-ce
   qu'on m'a écrit ? ». Les faire compter séparément par le frontend
   doublerait les appels à chaque écran pour reconstituer une addition. */
app.get("/api/activite", requireAuth, (req, res) => {
  try {
    const messages = countUnreadMessages(req.user.sub);
    const notifications = compterNonLues(req.user.sub);
    res.json({ messages, notifications, total: messages + notifications });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/notifications", requireAuth, (req, res) => {
  try {
    res.json({ items: listerNotifications(req.user.sub, parseInt(req.query.limit, 10) || 40) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Marque comme lues. Sans identifiants, tout le lot du membre.
app.post("/api/notifications/lues", requireAuth, (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : null;
    res.json({ marquees: marquerLues(req.user.sub, ids) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

if (require.main === module) {
  /* ── Purge unique au démarrage ───────────────────────────────────
     La remise à zéro s'appelle normalement depuis le panneau admin. Mais
     quand le contenu à effacer empêche justement de se servir du site, il
     faut pouvoir la déclencher sans passer par lui.

     REINITIALISER_AU_DEMARRAGE=true efface le contenu des détecteurs à
     l'ouverture, puis le dit. À retirer aussitôt : laissée en place, elle
     reviderait la base à chaque redéploiement — d'où l'avertissement, qui
     n'est pas décoratif. */
  if (process.env.REINITIALISER_AU_DEMARRAGE === "true") {
    try {
      const efface = reinitialiser({ garderHistorique: process.env.REINIT_GARDER_HISTORIQUE === "true" });
      const total = efface.reduce((n, e) => n + e.lignes, 0);
      console.log(`[reinit] ${total} ligne(s) effacée(s) :`);
      for (const e of efface) {
        console.log(`[reinit]   ${e.conservee ? "conservée" : String(e.lignes).padStart(6)} — ${e.table} (${e.quoi})`);
      }
      console.warn(
        "[reinit] ⚠️  RETIRE MAINTENANT la variable REINITIALISER_AU_DEMARRAGE : " +
          "laissée en place, elle revide la base à chaque redéploiement."
      );
    } catch (e) {
      console.error(`[reinit] échec : ${e.message}`);
    }
  }

  // Le site doit se remplir tout seul : les enseignes du registre qui
  // publient une page « promotions » deviennent des cibles au démarrage.
  // L'opération est idempotente — elle ne recrée rien et ne réactive rien
  // de ce que l'administration a mis en pause.
  // Les offres publiées avant la règle « jamais vers l'agrégateur » gardent
  // leur ancien lien tant qu'un scan ne les retouche pas — et il ne les
  // retouchera jamais si l'annonce a disparu de la source.
  // Une extraction cassée publie des dizaines d'offres sous un même nom, et
  // autant de fausses erreurs de prix. Elles ne partent pas d'elles-mêmes.
  try {
    const m = retirerOffresMalNommees();
    if (m.retirees > 0) {
      console.log(`[offres] ${m.retirees} offre(s) retirée(s) sous ${m.titres} titre(s) répété(s) — extraction cassée.`);
    }
  } catch (e) {
    console.error(`[offres] nettoyage impossible : ${e.message}`);
  }

  /* Les remises fabriquées par l'ancien calcul de référence. Une seule
     lecture fautive dans l'historique suffisait à devenir le « prix
     habituel » — les relevés corrects étaient écartés parce qu'ils valaient
     le prix du jour. Le calcul est réparé ; ces offres-là, non. */
  try {
    const m = retirerRemisesFabriquees();
    if (m.retirees > 0) {
      console.log(`[offres] ${m.retirees} remise(s) retirée(s) sur ${m.examinees} examinée(s) — référence fabriquée par l'ancien calcul.`);
    }
  } catch (e) {
    console.error(`[offres] retrait des fausses remises impossible : ${e.message}`);
  }

  /* Les articles ordinaires publiés comme s'ils étaient des affaires. La
     règle de publication ne les laisse plus passer ; ceux déjà en ligne, si. */
  try {
    const m = retirerOffresSansAvantage();
    if (m.retirees > 0) {
      console.log(`[offres] ${m.retirees} offre(s) retirée(s) — aucune remise d'au moins ${m.seuil} % démontrable.`);
    }
  } catch (e) {
    console.error(`[offres] retrait des offres sans avantage impossible : ${e.message}`);
  }

  try {
    const r = reparerLiensAgregateur();
    if (r.examinees > 0) {
      console.log(`[liens] ${r.repares} lien(s) réorienté(s) vers le marchand, ${r.retires} offre(s) retirée(s) faute de lien.`);
    }
  } catch (e) {
    console.error(`[liens] réparation impossible : ${e.message}`);
  }

  // Les cibles « page promotions » d'enseignes échouent toutes : le semis ne
  // les crée plus, mais celles déjà en base tournaient encore à chaque scan.
  try {
    const m = desactiverCiblesMortes();
    if (m.arretees > 0) console.log(`[cibles] ${m.arretees} cible(s) marchande(s) mise(s) en pause — aucune ne rendait de produit.`);
  } catch (e) {
    console.error(`[cibles] mise en pause impossible : ${e.message}`);
  }

  /* Le semis ne crée plus Vinted ni Aldi, mais il ne défait pas ce qui
     existe : les deux cibles tournaient encore et échouaient à chaque scan.
     Vinted ne publie que des catégories, Aldi n'affiche aucun prix. */
  try {
    const n = desactiverCataloguesAbandonnes();
    if (n > 0) console.log(`[cibles] ${n} catalogue(s) abandonné(s) mis en pause.`);
  } catch (e) {
    console.error(`[cibles] abandon impossible : ${e.message}`);
  }

  try {
    /* Les adresses qui ne sont pas des fiches produits partent avant le
       semis : la rotation interrogeait des catégories, des endpoints d'API
       et des pages d'accueil, soixante fois par passage, pour des pages qui
       ne portent aucun prix. Vidée, la cible se reconstitue toute seule. */
    {
      const purge = purgerFichesNonProduits();
      if (purge.retirees) {
        console.log(
          `[catalogue] ${purge.retirees} adresse(s) retirée(s) — pas des fiches produits ` +
            `(${purge.restantes} conservée(s)).`
        );
      }
    }

    const semis = semerCibles();
    if (semis.creees > 0) {
      console.log(`[cibles] ${semis.creees} cible(s) créée(s) depuis le registre — ${semis.total} au total.`);
    }
  } catch (e) {
    // Un semis qui échoue ne doit pas empêcher le site de démarrer.
    console.error(`[cibles] semis impossible : ${e.message}`);
  }

  /* Configuration Telegram, journalisée au démarrage.
     Sans cette ligne, une variable qui n'atteint pas le conteneur reste
     invisible jusqu'à ce qu'elle fasse des dégâts : un plafond posé à 1 mais
     jamais appliqué a laissé partir trente-deux messages sur le canal public
     au lieu d'un. Une configuration qu'on ne peut pas lire n'en est pas une. */
  {
    const t = telegram.etat();
    console.log(
      `[telegram] ${t.mode} — canal ${t.canal}, plafond ${t.capJournalier}/jour, ` +
        `remise min ${t.reglages.remiseMin} %, prix min ${t.reglages.prixMin} €, ` +
        `délai ${t.reglages.delaiMinutes} min, jeton ${t.reglages.token}`
    );
  }

  /* Et pour les connexions externes. La leçon est la même que le plafond
     Telegram posé à 1 et jamais appliqué : une configuration qu'on ne peut
     pas lire n'en est pas une. Une variable déclarée mais vide se comporte
     exactement comme une variable absente, et rien ne le disait. */
  {
    const actifs = identites.fournisseursActifs();
    console.log(
      actifs.length
        ? `[identites] connexion externe : ${actifs.join(", ")}`
        : "[identites] aucune connexion externe — GOOGLE_CLIENT_ID et APPLE_SERVICES_ID absentes ou vides."
    );
  }

  /* Même raison pour la lecture assistée : sans cette ligne, une clé absente
     ne se manifeste que par onze marchands qui n'entrent jamais dans le
     site, sans qu'aucune erreur ne le dise. On journalise ce qui est
     configuré — jamais la clé elle-même, évidemment. */
  {
    const lecture = require("./lecture");
    console.log(
      /* On demande au module ce qu'il fait, on ne le devine pas. Cette ligne
         recopiait la valeur par défaut et annonçait « claude-opus-5 » alors
         que Gemini était choisi — un journal qui ment est pire qu'un journal
         absent, parce qu'on le croit. */
      lecture.configure()
        ? `[lecture] active — ${lecture.fournisseur()} / ${lecture.MODELE()}, ` +
            `plafond ${lecture.budgetRestant()} fiche(s) par scan`
        : "[lecture] inactive — ANTHROPIC_API_KEY absente, le repli du balisage se taira."
    );
  }

  // Awin est la voie vers l'indépendance : les marchands refusent un robot
  // anonyme mais publient leur catalogue à leurs partenaires affiliés. Le
  // diagnostic dit tout de suite si le compte répond, plutôt que de laisser
  // découvrir au prochain scan qu'il manque une variable.
  diagnosticAwin()
    // async : la recherche des catalogues sur le réseau attend l'API.
    .then(async (d) => {
      if (d.actif) {
        console.log(
          `[awin] compte actif — ${d.programmes} programme(s) rejoint(s)` +
            (d.exemples.length ? ` : ${d.exemples.join(", ")}` : "")
        );
        /* Un compte qui répond ne veut pas dire un catalogue qui arrive. Il
           reste deux conditions, et rien ne les disait : on les a crues
           remplies parce que le compte était actif. Elles sont donc nommées
           une par une, avec ce qu'il faut faire. */
        if (!d.catalogues) {
          console.log(
            "[awin] AWIN_FEED_KEY absente — la clé des catalogues produits est " +
              "distincte du jeton API (Awin → Toolbox → Create-a-Feed). " +
              "Sans elle, aucun catalogue ne peut être téléchargé."
          );
        }
        console.log(
          `[awin] promotions : ${d.promosRejoints} sur les programmes rejoints, ` +
            `${d.promosReseau} sur l'ensemble du réseau (première page).`
        );

        /* Nos catalogues maison sont-ils sur Awin, et avec un flux produits ?
           Question décisive et qu'on ne peut pas deviner : un programme sans
           flux ne peut rien apporter à un comparateur, comme LiTime vient de
           le montrer — accepté, bons indicateurs, « Flux produits : Non ». */
        try {
          const { tousLesProgrammes, chercherProgrammes } = require("./awin");
          const tous = await tousLesProgrammes();
          console.log(`[awin] ${tous.length} programme(s) visibles sur le réseau.`);
          for (const r of chercherProgrammes(tous, CATALOGUES_MAISON)) {
            if (!r.trouves.length) {
              console.log(`[awin]   ${r.cherche} : absent du réseau`);
              continue;
            }
            for (const t of r.trouves.slice(0, 3)) {
              console.log(
                `[awin]   ${r.cherche} → « ${t.nom} » (id ${t.id})` +
                  `${t.rejoint ? ", rejoint" : ", non rejoint"}`
              );
            }
          }
        } catch (e) {
          console.error(`[awin] recherche des catalogues impossible : ${e.message}`);
        }

        /* Quels programmes publient un catalogue ? L'endpoint des programmes
           ne le dit pas — vérifié, aucun champ ne l'expose. Seule la liste
           des flux le sait, et elle demande AWIN_FEED_KEY. C'est là toute la
           valeur de cette clé : elle ne sert pas qu'à télécharger, elle sert
           à SAVOIR à quels programmes il vaut la peine de candidater. */
        try {
          const { fluxDisponibles, fluxFrancais } = require("./awin");
          const { marchandDepuisTexte } = require("./marchands");
          const f = await fluxDisponibles();
          if (!f.actif) {
            console.log(`[awin] liste des flux indisponible — ${f.raison}.`);
          } else {
            const fr = fluxFrancais(f.flux);
            console.log(
              `[awin] ${f.flux.length} catalogue(s) accessible(s), dont ${fr.length} sur le marché français` +
                ` — colonnes : ${f.colonnes.join(", ")}`
            );
            /* La répartition par région dit si le filtre est juste ou trop
               strict : dix-huit flux français sur 583 est un chiffre qu'on ne
               croit qu'après avoir vu les valeurs réellement servies dans la
               colonne. */
            const parRegion = new Map();
            for (const c of f.flux) {
              const r = (c.region || "?").trim() || "?";
              parRegion.set(r, (parRegion.get(r) || 0) + 1);
            }
            console.log(
              `[awin] régions : ${[...parRegion.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([r, n]) => `${r} ${n}`)
                .join(", ")}`
            );
            /* Les plus fournis d'abord : c'est le nombre de références qui
               décide s'il y a matière à un échantillon tournant. On signale
               ceux que le registre reconnaît déjà (★) — ceux-là s'intègrent
               au site sans rien ajouter au registre. */
            for (const c of fr.slice(0, 40)) {
              const connu = marchandDepuisTexte(c.nom || "") ? "★ " : "  ";
              console.log(
                `[awin] ${connu}flux ${c.feedId} — ${c.nom} (annonceur ${c.annonceurId}, ${c.adhesion})` +
                  ` — ${c.produits ?? "?"} réf., ${c.rayon || "rayon inconnu"}`
              );
            }
          }
        } catch (e) {
          console.error(`[awin] liste des flux impossible : ${e.message}`);
        }
        if (d.programmes === 0) {
          console.log(
            "[awin] aucun programme rejoint — un catalogue n'est accessible " +
              "qu'aux affiliés acceptés par le marchand. Il faut candidater " +
              "aux programmes depuis l'interface Awin et attendre leur accord."
          );
        }
      } else {
        console.log(`[awin] inactif — ${d.raison}`);
      }
    })
    .catch((e) => console.error(`[awin] diagnostic impossible : ${e.message}`));

  const serveur = app.listen(PORT, () => console.log(`RadarPrix backend en écoute sur le port ${PORT}`));

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
