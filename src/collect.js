// collect.js — Acquisition d'offres : flux RSS/feeds marchands + scraping SaaS.
//
// C'est la nouvelle porte d'entrée de la détection, qui remplace la
// machinerie retirée (SerpApi, Bright Data, sitemaps, cron maison). Deux
// canaux, aucun scraping écrit à la main :
//
//   1. Flux RSS / feeds marchands (feed_url par cible) : on lit ce que le
//      marchand ou l'agrégateur publie déjà, en RSS/Atom ou en feed XML
//      type Google Shopping. Aucune clé requise.
//
//   2. Scraping géré par Firecrawl (search_domains par cible) : on lui
//      demande de trouver les pages produits chez le marchand, puis d'en
//      extraire le contenu en markdown structuré. La clé Firecrawl reste
//      côté serveur (FIRECRAWL_API_KEY), jamais exposée au navigateur.
//
// Une « cible » est une recherche suivie (table watch_targets) : un produit
// et de quoi aller le chercher — un flux, ou des domaines marchands.
//
// À chaque scan (lancerScan), chaque cible produit un lot d'offres qui
// suit le même chemin que l'ancienne détection : stockage brut dans
// snapshots, analyse par algorithm.js (référence entre pairs + historique),
// et publication des anomalies dans la table unifiée `deals` sous le
// détecteur D3. Le vocabulaire et les routes publiques restent inchangés.
const { db, insertSnapshots, debuterScan, terminerScan, logSourceEvent, reglages } = require("./db");
const { publierNouveautes } = require("./telegram");
const { analyzeOffers } = require("./algorithm");

/** Réglages de publication, relus à chaque scan (modifiables depuis l'admin). */
const R_PUBLICATION = () => reglages();
const { upsertDeal, publierDeal, markMissingAsRemoved } = require("./dealsStore");
const { MARCHANDS, reconnaitreMarchand } = require("./marchands");
const { produitDepuisHtml, produitsDepuisHtml } = require("./extraction");
const { categorieDepuisLibelle } = require("./categories");
const { estPepper, extraireFils, offreDePepper } = require("./pepper");
const {
  decouvrirFiches, enregistrerFiches, prochainesFiches,
  marquerRelevee, marquerEchec, compterFiches, recuperer,
} = require("./catalogue");
const { sortieMarchand, marchandDepuisTexte, domaineDeMarchand } = require("./marchands");
const {
  urlCatalogue, offresDuCatalogue,
  promotions: promotionsAwin,
  programmesRejoints: programmesRejointsAwin,
} = require("./awin");
const zlib = require("node:zlib");

/* Agent unique, au format conventionnel des robots — celui de Googlebot :
   « Mozilla/5.0 (compatible; Nom/version; +adresse) ». Il nomme RadarPrix
   et laisse une adresse où nous joindre ; le préfixe Mozilla n'est pas un
   déguisement mais la forme que des serveurs exigent, refusant par un 403
   tout agent qui ne commence pas ainsi. Dealabs le fait, alors que son
   robots.txt autorise « / » et n'interdit ni /hot ni /rss — le filtre est
   grossier, pas une consigne. Les consignes, elles, se lisent dans
   robots.txt, et on les respecte. */
/* Les pages HTML passent par navigateur.js — jeu d'en-têtes complet, pot à
   cookies, pause par hôte. AGENT ne sert plus qu'aux flux XML, qui n'ont
   jamais été protégés et qu'un en-tête honnête suffit à obtenir. */
const { recuperer: naviguer } = require("./navigateur");
const lecture = require("./lecture");

const AGENT = "Mozilla/5.0 (compatible; RadarPrix/1.0; +https://radarprix.fr)";
const Parser = require("rss-parser");
const { XMLParser } = require("fast-xml-parser");

const FIRECRAWL_URL = process.env.FIRECRAWL_URL || "https://api.firecrawl.dev/v2";

db.exec(`
  CREATE TABLE IF NOT EXISTS watch_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'tout',
    merchant TEXT,
    feed_url TEXT,
    -- Domaines marchands (JSON array) pour la recherche Firecrawl :
    -- ["amazon.fr", "cdiscount.com"]...
    search_domains TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_watch_targets_active ON watch_targets(active);
`);

/* Troisième canal, ajouté après coup : la page « promotions » publique
   d'une enseigne. Une base déjà en service n'a pas la colonne, d'où la
   migration — le catch couvre le cas normal où elle existe déjà. */
try {
  db.exec("ALTER TABLE watch_targets ADD COLUMN promo_url TEXT");
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

/* Quatrième canal : le catalogue d'un marchand, découvert par son propre
   sitemap. C'est le seul qui produise des anomalies mesurées par nous. */
try {
  db.exec("ALTER TABLE watch_targets ADD COLUMN catalogue_url TEXT");
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

/* Cinquième canal : le catalogue produits d'un marchand via le réseau
   d'affiliation. On y stocke les identifiants de flux Awin (« feed id »),
   séparés par des virgules : un seul téléchargement rapporte le catalogue
   de plusieurs marchands à la fois.

   Le module awin.js existait depuis un moment, testé, mais n'était appelé
   nulle part ailleurs qu'au diagnostic de démarrage : aucune offre n'en
   sortait, quelles que soient les clés fournies. C'est ce que cette colonne
   et le collecteur ci-dessous réparent. */
try {
  db.exec("ALTER TABLE watch_targets ADD COLUMN awin_feeds TEXT");
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

// ── Cibles suivies ──────────────────────────────────────────────

function decouperDomaines(cible) {
  try {
    return JSON.parse(cible.search_domains || "[]");
  } catch {
    return [];
  }
}

function enJson(ligne) {
  return {
    id: ligne.id,
    query: ligne.query,
    category: ligne.category,
    merchant: ligne.merchant,
    feedUrl: ligne.feed_url,
    promoUrl: ligne.promo_url || null,
    catalogueUrl: ligne.catalogue_url || null,
    awinFeeds: ligne.awin_feeds || null,
    searchDomains: decouperDomaines(ligne),
    active: Boolean(ligne.active),
    createdAt: ligne.created_at,
  };
}

/** Toutes les cibles, ou seulement les actives. */
function listTargets({ actives = false } = {}) {
  const lignes = actives
    ? db.prepare("SELECT * FROM watch_targets WHERE active = 1 ORDER BY id").all()
    : db.prepare("SELECT * FROM watch_targets ORDER BY id").all();
  return lignes.map(enJson);
}

function getTarget(id) {
  const ligne = db.prepare("SELECT * FROM watch_targets WHERE id = ?").get(id);
  return ligne ? enJson(ligne) : null;
}

/**
 * Ajoute une cible. Il faut un produit ET de quoi aller le chercher :
 * un flux, ou au moins un domaine marchand pour Firecrawl. Une cible sans
 * aucune source ne ferait que des erreurs à chaque scan.
 */
function addTarget({ query, category, merchant, feedUrl, promoUrl, catalogueUrl, awinFeeds, domains }) {
  const propre = String(query || "").trim();
  if (propre.length < 3) return { ok: false, error: "Le produit suivi doit faire au moins 3 caractères." };
  const flux = feedUrl ? String(feedUrl).trim() : "";
  const promo = promoUrl ? String(promoUrl).trim() : "";
  const catalogue = catalogueUrl ? String(catalogueUrl).trim().replace(/\/+$/, "") : "";
  const domaines = Array.isArray(domains) ? domains.map((d) => String(d).trim()).filter(Boolean) : [];

  /* Identifiants de flux Awin : des nombres séparés par des virgules. On
     les normalise ici plutôt qu'à la collecte, pour qu'une saisie fautive
     soit refusée à l'ajout et non découverte au milieu d'un scan. */
  const awin = String(awinFeeds || "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  if (awin.some((f) => !/^\d+$/.test(f))) {
    return { ok: false, error: "Les identifiants de flux Awin doivent être des nombres séparés par des virgules." };
  }

  if (!flux && !promo && !catalogue && !awin.length && domaines.length === 0) {
    return { ok: false, error: "Il faut un flux (feedUrl), une page promotions (promoUrl), un catalogue (catalogueUrl), des flux Awin (awinFeeds) ou au moins un domaine marchand (domains)." };
  }
  for (const [valeur, quoi] of [[flux, "du flux"], [promo, "de la page promotions"], [catalogue, "du catalogue"]]) {
    if (valeur && !/^https?:\/\//.test(valeur)) {
      return { ok: false, error: `L'URL ${quoi} doit commencer par http:// ou https://` };
    }
  }
  const info = db
    .prepare(
      `INSERT INTO watch_targets (query, category, merchant, feed_url, promo_url, catalogue_url, awin_feeds, search_domains)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      propre,
      category || "tout",
      merchant ? String(merchant).trim() : null,
      flux || null,
      promo || null,
      catalogue || null,
      awin.length ? awin.join(",") : null,
      JSON.stringify(domaines)
    );
  return { ok: true, target: getTarget(info.lastInsertRowid) };
}

/** Met à jour les champs modifiables d'une cible (active, flux, domaines…). */
function updateTarget(id, champs = {}) {
  const cible = getTarget(id);
  if (!cible) return { ok: false, error: "Cible introuvable." };

  if (champs.active !== undefined && champs.feedUrl === undefined && champs.domains === undefined) {
    db.prepare("UPDATE watch_targets SET active = ? WHERE id = ?").run(champs.active ? 1 : 0, id);
    return { ok: true, target: getTarget(id) };
  }

  const feedUrl = champs.feedUrl !== undefined ? String(champs.feedUrl).trim() : cible.feedUrl;
  const domaines = champs.domains !== undefined
    ? (Array.isArray(champs.domains) ? champs.domains.map((d) => String(d).trim()).filter(Boolean) : [])
    : cible.searchDomains;
  /* Une cible Awin ou catalogue n'a ni flux ni domaine : exiger l'un des
     deux ici la rendait immodifiable — on ne pouvait même plus la mettre en
     pause. La vérification porte donc sur l'ensemble des canaux. */
  const aUnCanal = feedUrl || domaines.length > 0 || cible.promoUrl || cible.catalogueUrl || cible.awinFeeds;
  if (!aUnCanal) {
    return { ok: false, error: "Il faut un flux (feedUrl) ou au moins un domaine marchand (domains)." };
  }
  db.prepare(
    `UPDATE watch_targets SET
       category = ?, merchant = ?, feed_url = ?, search_domains = ?, active = ?
     WHERE id = ?`
  ).run(
    champs.category !== undefined ? champs.category : cible.category,
    champs.merchant !== undefined ? String(champs.merchant).trim() : cible.merchant,
    feedUrl || null,
    JSON.stringify(domaines),
    champs.active !== undefined ? (champs.active ? 1 : 0) : (cible.active ? 1 : 0),
    id
  );
  return { ok: true, target: getTarget(id) };
}

function deleteTarget(id) {
  const info = db.prepare("DELETE FROM watch_targets WHERE id = ?").run(id);
  return info.changes > 0;
}

// ── Parsing des flux ────────────────────────────────────────────

/** Extraits d'un rss-parser : certains flux publient le prix en balise dédiée. */
const rssParser = new Parser({
  customFields: {
    item: [
      ["price", "price"],
      ["g:price", "price"],
      ["s:price", "price"],
      // Prix courant quand le flux distingue le tarif barré du tarif payé :
      // c'est ce couple qui donne une vraie remise plutôt qu'une devinette.
      ["g:sale_price", "salePrice"],
      ["sale_price", "salePrice"],
      ["g:brand", "brand"],
      ["g:condition", "condition"],
      ["g:image_link", "imageLink"],
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail"],
      ["source", "sourceName"],
      // Espace de nom Pepper (Dealabs, Hotukdeals, Mydealz…). Il déclare le
      // marchand et le prix en clair, dans des attributs : la source la plus
      // sûre qui soit, et elle était ignorée. Vingt-neuf articles sur trente
      // du flux Dealabs la portent.
      ["pepper:merchant", "pepperMerchant"],
    ],
  },
});

/* Contextes qui désignent autre chose que le prix de l'article. Sans ce
   filtre, « Livraison 4,99 € — Casque 199 € » retenait le port : le premier
   montant rencontré gagnait, quel qu'il soit. */
const AVANT_NON_PRIX = /(livraison|frais de port|port|[ée]conomis\w*|remise|r[ée]duction|offert\w*|cashback|rembours\w*|cr[ée]dit\w*)[^.;,]{0,20}$/i;
const APRES_NON_PRIX = /^[^.;]{0,20}(d'achats?|offerts?|de r[ée]duction|de remise|rembours[ée]s?)/i;

/** Un nombre monétaire, séparateurs de milliers compris : 1 299,00 · 1.299,00 · 499.99 */
const NOMBRE = String.raw`\d{1,3}(?:[ .\u202F\u2009,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;

/**
 * Convertit un nombre monétaire écrit à la française ou à l'anglaise.
 *
 * La règle qui lève l'ambiguïté : un séparateur suivi d'exactement une ou
 * deux décimales en fin de nombre EST la virgule décimale ; tout le reste
 * sépare des milliers. « 1.299,00 » vaut donc 1299, et « 499.99 » vaut
 * 499,99 — sans avoir à deviner la langue de la source.
 */
function versNombre(brut) {
  const decimal = brut.match(/[.,](\d{1,2})$/);
  const entier = (decimal ? brut.slice(0, -decimal[0].length) : brut).replace(/[^\d]/g, "");
  const n = parseFloat(decimal ? `${entier}.${decimal[1]}` : entier);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extrait un prix d'une chaîne ("699,00 €", "EUR 499.99", "1 299,00 €").
 *
 * Volontairement prudent : le prix doit être collé à un symbole ou mot
 * monétaire. Sans cette exigence, un titre « iPhone 15 128 Go » ferait
 * croire à un prix de 15 € ou 128 € — c'est le genre de faux signal qui
 * pollue toute la détection en aval. On accepte la monnaie avant comme
 * après le nombre, les deux conventions existant selon la source.
 *
 * Deux prudences supplémentaires, apprises en sondant des libellés réels :
 * les séparateurs de milliers sont respectés (« 1 299 € » ne vaut pas
 * 299 €), et les montants qui désignent un port, une remise ou un seuil
 * d'achat sont écartés. Les deux erreurs tiraient le prix vers le bas, donc
 * fabriquaient de fausses anomalies sur les articles chers — exactement là
 * où une vraie erreur de prix compte.
 *
 * Quand plusieurs prix subsistent, le premier gagne : c'est la convention
 * du prix barré, où le prix de vente précède le prix de référence.
 */
function extrairePrix(texte) {
  if (!texte) return null;
  const propre = String(texte).replace(/[\u00A0\u202F\u2009]/g, " ");
  // La garde de fin est \p{L} et non \w : « eurêka » commence par « eur »
  // suivi d'un « ê » que \w ne couvre pas, et le lot devenait un prix.
  const motif = new RegExp(
    String.raw`(?:(${NOMBRE})\s*(?:€|euros?|eur)(?![\p{L}\p{N}])|(?:€|euros?|eur)\s*(${NOMBRE}))`,
    "giu",
  );

  // Le contexte examiné s'arrête au montant précédent : sinon un « Livraison »
  // en tête de ligne disqualifierait aussi le prix de l'article qui suit.
  let curseur = 0;
  for (const m of propre.matchAll(motif)) {
    const avant = propre.slice(curseur, m.index);
    const apres = propre.slice(m.index + m[0].length);
    curseur = m.index + m[0].length;
    if (AVANT_NON_PRIX.test(avant) || APRES_NON_PRIX.test(apres)) continue;
    const n = versNombre(m[1] || m[2]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/* ── Ce qu'un flux dit en plus du titre et du prix ────────────────
   Un flux marchand transporte presque toujours le vendeur, le prix barré
   et une image. Ne lire que le titre et le prix, comme au départ, donnait
   des cartes sans vendeur, sans remise et sans visuel — c'est-à-dire des
   cartes qui ne servent à rien.

   Rien ici n'est inventé : chaque valeur vient d'une balise du flux ou
   d'une mention explicite de son texte. Quand la source ne dit rien, le
   champ reste vide, ce qui est la vérité. */

/** Nom d'hôte d'une URL, sans « www. ». Renvoie null si l'URL est illisible. */
function hote(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Nom d'enseigne déduit d'un domaine : « www.amazon.fr » → « Amazon ».
 *
 * On prend l'étiquette qui précède l'extension, et non la première :
 * « boutique.leclerc.fr » désigne Leclerc, pas « Boutique ».
 */
function nomDeMarchand(domaine) {
  if (!domaine) return null;
  const parts = domaine.split(".").filter(Boolean);
  const nom = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  if (!nom || nom.length < 2) return null;
  return nom.charAt(0).toUpperCase() + nom.slice(1);
}

/** Première image d'un fragment HTML — les flux la mettent souvent là. */
function premiereImage(html) {
  const m = String(html || "").match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

/* Un prix barré s'écrit de deux façons : en HTML (<del>, <s>, <strike>) ou
   en toutes lettres. Les deux sont couvertes, dans cet ordre — la balise
   est explicite là où la formule demande de faire confiance au texte. */
const BARRE_HTML = /<(?:del|s|strike)\b[^>]*>([\s\S]{0,120}?)<\/(?:del|s|strike)>/i;
/* Le même motif, pour retirer ces blocs AVANT de chercher le prix payé.
   « <del>349 €</del> 279,99 € » rendait 349 : le premier montant du texte
   gagnait, et l'article s'affichait à son prix d'avant la remise. */
const TOUTES_BARRES = /<(?:del|s|strike)\b[^>]*>[\s\S]*?<\/(?:del|s|strike)>/gi;
const BARRE_TEXTE = /(?:au lieu de|prix conseill[ée]|prix public|prix bar[ré]{1,2}|anciennement|initialement|[ée]tait\s*[àa]?)\s*:?\s*([^<.;)]{0,24})/i;


/**
 * Prix de référence annoncé par la source, ou null.
 *
 * Deux chemins seulement, et tous deux explicites : une balise de prix
 * barré, ou une formule « au lieu de » suivie d'un montant. Une référence
 * inférieure ou égale au prix payé est rejetée : ce n'est pas une remise,
 * c'est une coquille de la source.
 */
function prixReference(texte, prix) {
  if (!Number.isFinite(prix) || prix <= 0) return null;
  const brut = String(texte || "");

  for (const motif of [BARRE_HTML, BARRE_TEXTE]) {
    const m = brut.match(motif);
    const ref = m ? extrairePrix(m[1]) : null;
    if (Number.isFinite(ref) && ref > prix) return ref;
  }

  // Un pourcentage seul dans un titre ne dit PAS une remise, et retrouver
  // le prix d'avant par le calcul était une mauvaise idée : « Clavier
  // C98FRF - 96% Effet Hall » désigne le format du clavier, et le site a
  // affiché « 69,48 € au lieu de 1737 € », soit −96 %. Une remise
  // invraisemblable détruit plus de crédibilité que dix remises absentes
  // n'en font gagner. On ne retient donc qu'une référence explicitement
  // écrite : un prix barré, ou un « au lieu de » suivi d'un montant.
  return null;
}

/* Vocabulaire du Google Merchant Center, puis les mots français que les
   flux emploient. Un article reconditionné mêlé au neuf ferait passer sa
   décote normale pour une bonne affaire. */
const ETATS_FLUX = [
  [/(refurbished|reconditionn|remis [àa] neuf|seconde vie)/i, "reconditionne"],
  [/(\bused\b|occasion|d[ée]j[àa] servi)/i, "occasion"],
];

/** État de l'article d'après la balise g:condition, puis d'après son texte. */
function etatArticle(condition, texte) {
  const source = `${condition || ""} ${texte || ""}`;
  for (const [motif, etat] of ETATS_FLUX) {
    if (motif.test(source)) return etat;
  }
  return "neuf";
}

/* Les agrégateurs décrivent un produit en listant ses points en gras :
   « <strong>Matériau</strong> : résine ». C'est la seule forme structurée
   de caractéristiques qu'on trouve dans un flux, et elle est exploitable. */
const PUCE_CARACTERISTIQUE = /<li[^>]*>\s*(?:<p[^>]*>)?\s*<strong>([^<]{2,40})<\/strong>\s*:?\s*([^<]{1,160})/gi;

function caracteristiquesDeTexte(html) {
  const sortie = [];
  for (const m of String(html || "").matchAll(PUCE_CARACTERISTIQUE)) {
    const nom = m[1].replace(/\s*:\s*$/, "").trim();
    const valeur = m[2].replace(/^\s*:\s*/, "").trim();
    if (nom && valeur) sortie.push({ nom, valeur });
    if (sortie.length >= 12) break; // une carte n'en montrera jamais plus
  }
  return sortie;
}

/**
 * Retire l'en-tête « 39€ - Outlet Moto » d'une description.
 *
 * Les agrégateurs l'ouvrent par le prix et le vendeur, que la carte affiche
 * déjà juste à côté. On retire les valeurs EXACTES qu'on connaît, jamais un
 * motif approchant : une première version devinait la fin du nom et coupait
 * « Outlet Moto » en deux, laissant une description qui commençait par
 * « Moto ».
 */
function sansEnTeteRedondante(texte, prixBrut, vendeur) {
  let sortie = String(texte || "").trimStart();
  for (const valeur of [prixBrut, vendeur]) {
    if (!valeur) continue;
    const mot = String(valeur).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    sortie = sortie.replace(new RegExp(`^${mot}\\s*[-–—:]?\\s*`, "i"), "");
  }
  return sortie.trim();
}

/** Texte lisible d'un fragment HTML, entités courantes comprises. */
function texteLisible(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|li|ul|div|h\d)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:#39|apos|rsquo);/gi, "'")
    .replace(/&(?:lt|gt);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Offre brute d'un flux, ramenée aux champs que la détection attend. */
function offreDeFlux(item, i, merchant) {
  const name = String(item.title || "").trim();
  if (!name) return null;
  const url = item.link || item.guid || null;

  // Tout le texte de l'article en un bloc : le prix barré, la remise et
  // l'état s'y trouvent indifféremment selon les flux.
  const texte = [item.title, item.content, item.contentSnippet, item.summary]
    .filter(Boolean)
    .join(" \n ");

  // Balise Pepper : le marchand et le prix, déclarés en clair par la source.
  // C'est la lecture la plus sûre disponible — aucune interprétation.
  const pepper = item.pepperMerchant && item.pepperMerchant.$ ? item.pepperMerchant.$ : null;

  // Le prix payé se cherche sur un texte débarrassé des prix barrés.
  const sansBarre = (v) => String(v || "").replace(TOUTES_BARRES, " ");

  const prix =
    extrairePrix(pepper && pepper.price) ||
    extrairePrix(item.salePrice) ||
    extrairePrix(item.price) ||
    extrairePrix(sansBarre(item.content)) ||
    extrairePrix(sansBarre(item.contentSnippet)) ||
    // Dernier recours : le prix dans le titre lui-même. Sans exigence de
    // monnaie, un titre « iPhone 15 128 Go » ferait n'importe quoi — la
    // prudence est dans extrairePrix, pas ici.
    extrairePrix(item.title) ||
    null;
  if (!Number.isFinite(prix)) return null;

  // Quand le flux sépare tarif barré et tarif payé, la référence est
  // donnée, pas déduite : c'est le cas le plus fiable.
  const refAnnoncee =
    (item.salePrice ? extrairePrix(item.price) : null) || prixReference(texte, prix);

  const media = Array.isArray(item.mediaContent) ? item.mediaContent[0] : item.mediaContent;
  const img =
    item.imageLink ||
    (item.enclosure && item.enclosure.url) ||
    (media && (media.$ ? media.$.url : media.url)) ||
    (item.mediaThumbnail && (item.mediaThumbnail.$ ? item.mediaThumbnail.$.url : item.mediaThumbnail.url)) ||
    premiereImage(item.content) ||
    null;

  // <source> nomme le site d'origine de l'article (RSS 2.0). rss-parser le
  // rend en objet quand la balise porte son attribut url.
  const nomSource =
    typeof item.sourceName === "string"
      ? item.sourceName
      : item.sourceName && item.sourceName._ ? item.sourceName._ : null;

  const corps = item.content || item.contentSnippet || item.summary || "";
  return {
    externalId: String(item.guid || item.link || `item-${i}`),
    name,
    price: prix,
    refPriceAnnonce: Number.isFinite(refAnnoncee) ? refAnnoncee : null,
    url,
    seller: (pepper && pepper.name) || item.brand || nomSource || merchant || null,
    img: img || null,
    category: categorieDepuisLibelle(item.categories),
    // La description du flux est du HTML : on en garde le texte, borné,
    // et on en tire les caractéristiques listées en gras.
    // Les agrégateurs ouvrent leur description par « 39€ - Outlet Moto »,
    // soit le prix et le vendeur que la carte affiche déjà juste à côté.
    // Répéter les deux mange la place de ce qui décrit vraiment l'article.
    description:
      sansEnTeteRedondante(
        texteLisible(corps),
        pepper && pepper.price,
        (pepper && pepper.name) || merchant
      ).slice(0, 1200) || null,
    caracteristiques: caracteristiquesDeTexte(corps),
    itemCondition: etatArticle(item.condition, texte),
  };
}

/** Parse un flux RSS 2.0 ou Atom. */
async function parseFluxRSS(xml) {
  const feed = await rssParser.parseString(xml);
  return (feed.items || []).map((item, i) => offreDeFlux(item, i)).filter(Boolean);
}

/** Parse un feed marchand XML type Google Shopping (<item> avec <title>, <link>, <g:price>…). */
function parseFluxXML(xml) {
  const doc = new XMLParser({ ignoreAttributes: false }).parse(xml);
  const canal = doc.rss?.channel || doc.channel || doc.feed || null;
  if (!canal) return [];
  // Un seul <item> et fast-xml-parser rend un objet, pas un tableau. Le
  // raccourci qui renvoyait cet objet tel quel court-circuitait toute la
  // conversion : le flux ressortait en balises brutes, sans nom ni prix.
  const brut = canal.item || canal.entry || [];
  const items = Array.isArray(brut) ? brut : [brut].filter(Boolean);
  return items
    .map((item, i) => {
      const name = String(item.title || "").trim();
      if (!name) return null;
      const url = item.link || item["g:link"] || item.id || null;
      // g:sale_price est le prix payé, g:price le tarif de base : quand les
      // deux existent, la remise est annoncée par le marchand lui-même.
      const solde = extrairePrix(item["g:sale_price"] || item.sale_price);
      const base = extrairePrix(item["g:price"] || item.price || item["s:price"]);
      const prix = Number.isFinite(solde) ? solde : base;
      if (!Number.isFinite(prix)) return null;

      const texte = [name, item.description, item["g:description"]].filter(Boolean).join(" \n ");
      const ref = Number.isFinite(solde) && Number.isFinite(base) && base > solde
        ? base
        : prixReference(texte, prix);

      return {
        externalId: String(item.id || item["g:id"] || item.guid || item.link || `xml-${i}`),
        name,
        price: prix,
        refPriceAnnonce: Number.isFinite(ref) ? ref : null,
        url,
        seller: item["g:brand"] || item["g:store_name"] || null,
        img: item["g:image_link"] || item["g:additional_image_link"] || null,
        itemCondition: etatArticle(item["g:condition"], texte),
      };
    })
    .filter(Boolean);
}

/**
 * Télécharge un flux et le parse. On tente RSS/Atom d'abord, puis le feed
 * XML plat : certains flux annoncent du RSS alors qu'ils servent du XML
 * marchand, et l'inverse n'a pas de coût.
 */
async function collecterFlux(cible) {
  const rep = await fetch(cible.feedUrl, {
    headers: { "User-Agent": AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!rep.ok) throw new Error(`flux indisponible (HTTP ${rep.status})`);
  const texte = await rep.text();
  let offres = await parseFluxRSS(texte);
  if (offres.length === 0) offres = parseFluxXML(texte);

  // Quand le flux ne nomme pas le vendeur, on interroge le registre des
  // enseignes (marchands.js) : d'abord le domaine du lien, puis le texte de
  // l'annonce. C'est ce second chemin qui rend exploitables les flux
  // d'agrégateurs — leurs liens repassent par leur propre domaine, mais
  // leurs titres nomment le marchand (« … à 199 € chez Boulanger »).
  //
  // Reste le repli maison sur le domaine, pour les enseignes absentes du
  // registre : cent vingt noms ne couvrent pas tout le commerce français.
  const hoteDuFlux = hote(cible.feedUrl);
  return offres.map((o) => {
    const connu = reconnaitreMarchand({ url: o.url, texte: `${o.name} ${o.description || ""}` });
    const hoteDuLien = hote(o.url);
    const deduit = hoteDuLien && hoteDuLien !== hoteDuFlux ? nomDeMarchand(hoteDuLien) : null;
    return { ...o, seller: o.seller || (connu && connu.nom) || cible.merchant || deduit || null };
  });
}

// ── Scraping SaaS (Firecrawl) ───────────────────────────────────

function cleFirecrawl() {
  return process.env.FIRECRAWL_API_KEY;
}

async function appelFirecrawl(chemin, corps) {
  if (!cleFirecrawl()) throw new Error("FIRECRAWL_API_KEY absente — cible ignorée.");
  const rep = await fetch(`${FIRECRAWL_URL}${chemin}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cleFirecrawl()}`,
    },
    body: JSON.stringify(corps),
    signal: AbortSignal.timeout(30000),
  });
  if (!rep.ok) throw new Error(`Firecrawl ${chemin} : HTTP ${rep.status}`);
  const json = await rep.json();
  if (!json.success) throw new Error(json.error || `Firecrawl ${chemin} : échec`);
  return json.data;
}

/** Trouve les pages produits chez les domaines de la cible. */
async function rechercheFirecrawl(cible) {
  const data = await appelFirecrawl("/search", {
    query: cible.query,
    limit: 6,
    includeDomains: cible.searchDomains,
    country: "FR",
    lang: "fr",
  });
  // La réponse regroupe les résultats par source de recherche : on lit le
  // groupe "web", et on accepte aussi une réponse en tableau simple pour
  // rester tolérant à l'évolution de l'API.
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.web) ? data.web : [];
}

/**
 * Le prix d'une page, dans l'ordre de fiabilité :
 *   1. l'extraction produit structurée de Firecrawl, quand elle est fournie ;
 *   2. le premier prix trouvé dans le markdown (fenêtre bornée : le prix
 *      figure presque toujours dans le haut de la page).
 */
function prixDePage(donnees) {
  const variantes = donnees.product?.variants || [];
  const prixStructures = variantes
    .map((v) => v.price?.amount)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (prixStructures.length > 0) return Math.min(...prixStructures);
  return extrairePrix((donnees.markdown || "").slice(0, 4000));
}

async function collecterFirecrawl(cible) {
  const resultats = await rechercheFirecrawl(cible);
  const offres = [];
  // Trois pages au plus par cible et par scan : chaque scrape est facturé,
  // et la première page pertinente suffit à nourrir la comparaison de prix.
  for (const r of resultats.slice(0, 3)) {
    if (!r.url) continue;
    try {
      // On demande le HTML brut EN PLUS du markdown : c'est dans le HTML
      // que vit le balisage schema.org, et le markdown le fait disparaître.
      // Sans lui, il ne reste qu'à deviner des nombres dans du texte — ce
      // qui produisait des prix faux sur les pages un peu chargées.
      // `onlyMainContent` est désactivé pour la même raison : le JSON-LD
      // est dans le <head>, que ce réglage supprime.
      const donnees = await appelFirecrawl("/scrape", {
        url: r.url,
        formats: ["markdown", "rawHtml"],
        onlyMainContent: false,
      });

      const fiche = donnees.rawHtml ? produitDepuisHtml(donnees.rawHtml) : null;
      // Le prix déclaré par le marchand prime ; la lecture du markdown ne
      // sert plus qu'aux pages sans aucun balisage.
      const prix = fiche && Number.isFinite(fiche.prix) ? fiche.prix : prixDePage(donnees);
      if (!Number.isFinite(prix)) continue;

      const titre = (fiche?.nom || donnees.metadata?.title || r.title || cible.query).trim();
      const marchand = reconnaitreMarchand({ url: r.url, texte: titre });
      offres.push({
        externalId: fiche?.sku || r.url,
        name: titre.slice(0, 200),
        price: prix,
        refPriceAnnonce: fiche?.prixReference ?? null,
        url: r.url,
        seller: cible.merchant || (marchand && marchand.nom) || fiche?.marque || null,
        img: fiche?.image || donnees.metadata?.ogImage || null,
        description: fiche?.description || null,
        caracteristiques: fiche?.caracteristiques || [],
        itemCondition: fiche?.etat || "neuf",
        finOffre: fiche?.finOffre || null,
        debutOffre: fiche?.debutOffre || null,
        balisage: fiche?.source || "texte",
      });
    } catch (e) {
      // Une page en échec ne doit pas faire échouer toute la cible : la
      // suivante peut très bien répondre.
      console.warn(`[collect] scrape échoué : ${r.url} — ${e.message}`);
    }
  }
  return offres;
}

/* Nombre de fiches relevées à chaque passage d'un catalogue. Cinquante mille
   fiches d'un coup seraient aussi inutiles qu'agressives : on en prend une
   tranche, et le tour complet se fait en plusieurs jours. Huit passages par
   jour à soixante fiches font près de cinq cents relevés quotidiens par
   marchand — assez pour voir bouger un prix, assez peu pour rester un
   visiteur poli. */
const FICHES_PAR_PASSAGE = 60;

/* Une pause entre deux fiches. Un marchand qui nous laisse lire son
   catalogue mérite qu'on ne le martèle pas ; et un robot trop pressé se
   fait bloquer, ce qui coûte la source entière. */
const PAUSE_ENTRE_FICHES = 400;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Relève une tranche du catalogue d'un marchand.
 *
 * C'est le seul canal dont les anomalies sont les nôtres. Les autres
 * rapportent ce qu'un tiers a déjà qualifié d'affaire ; celui-ci relève des
 * prix ordinaires, encore et encore, et laisse algorithm.js dire lequel a
 * décroché. Un prix tombé de 900 € à 90 € ne se voit que si l'on a relevé
 * les 900 € la veille.
 */
async function collecterCatalogue(cible) {
  const racine = cible.catalogueUrl;

  // Le catalogue se redécouvre quand il est vide ou presque : un sitemap
  // change lentement, le relire à chaque passage serait du gaspillage.
  if (compterFiches(cible.id) < FICHES_PAR_PASSAGE) {
    const urls = await decouvrirFiches(racine);
    const ajoutees = enregistrerFiches(cible.id, urls);
    console.log(`[catalogue] ${cible.merchant || racine} : ${urls.length} fiche(s) listée(s), ${ajoutees} nouvelle(s).`);
  }

  const tranche = prochainesFiches(cible.id, FICHES_PAR_PASSAGE);
  if (!tranche.length) throw new Error("catalogue vide — aucune fiche à relever");

  const offres = [];
  let lues = 0;
  for (const fiche of tranche) {
    try {
      const page = await recuperer(fiche.url, 20000);
      let p = page.texte ? produitDepuisHtml(page.texte) : null;

      /* Repli, et repli seulement. Le balisage passe d'abord et garde la
         main : il est gratuit, instantané, et c'est le marchand lui-même qui
         l'écrit. Le modèle n'intervient que sur les pages où il n'y a
         littéralement rien à lire — onze marchands du registre sont dans ce
         cas, mesurés le 24 août. Un repli qui se déclencherait à tort
         coûterait de l'argent sur chaque fiche, huit fois par jour. */
      if ((!p || !Number.isFinite(p.prix)) && page.texte && lecture.configure()) {
        const lu = await lecture.lireSousBudget(page.texte);
        if (lu) {
          p = {
            nom: lu.nom,
            prix: lu.prix,
            prixReference: lu.prixReference,
            image: p ? p.image : null,
            description: p ? p.description : null,
            caracteristiques: [],
            source: "modele",
          };
          lues++;
        }
      }

      if (!p || !Number.isFinite(p.prix)) {
        marquerEchec(fiche.id);
        continue;
      }
      marquerRelevee(fiche.id);
      offres.push({
        externalId: p.sku || fiche.url,
        name: String(p.nom || "").slice(0, 200),
        price: p.prix,
        refPriceAnnonce: p.prixReference,
        // Le lien est la fiche elle-même : on envoie l'acheteur exactement
        // là où le prix a été relevé. C'est le seul canal qui le permette.
        url: fiche.url,
        lienType: "produit",
        seller: cible.merchant || null,
        img: p.image,
        description: p.description ? String(p.description).slice(0, 1200) : null,
        caracteristiques: p.caracteristiques || [],
        itemCondition: p.etat || "neuf",
        finOffre: p.finOffre,
        debutOffre: p.debutOffre,
        category: cible.category,
        balisage: p.source,
      });
    } catch {
      marquerEchec(fiche.id);
    }
    await dormir(PAUSE_ENTRE_FICHES);
  }

  if (lues) {
    // Sans ce chiffre, un marchand qui casse son balisage passerait pour
    // toujours lisible, et la facture monterait sans que rien ne le dise.
    console.log(
      `[lecture] ${cible.merchant || racine} : ${lues} fiche(s) lue(s) par le modèle ` +
        `(${lecture.budgetRestant()} restant(s) sur ce scan).`
    );
  }

  if (!offres.length) throw new Error(`aucune fiche lisible sur ${tranche.length} relevée(s)`);

  // Filet de sécurité, appris cher. Quand un marchand balise mal ses pages,
  // toutes ses fiches ressortent sous le même nom — « Accueil » pour Electro
  // Dépôt. L'analyse les groupe alors comme un seul produit, en tire un prix
  // de référence commun, et publie autant de fausses erreurs de prix qu'il y
  // a d'articles bon marché. Le site a affiché vingt-cinq « -80 % » inventés
  // avant que ce contrôle n'existe.
  //
  // Un nom qui revient sur plus d'un tiers d'une tranche ne décrit pas un
  // catalogue : il décrit une extraction cassée. On refuse la tranche
  // entière plutôt que d'en publier une part fausse — et l'échec est
  // journalisé, donc visible dans le tableau de bord.
  const parNom = new Map();
  for (const o of offres) parNom.set(o.name, (parNom.get(o.name) || 0) + 1);
  const [nomDominant, occurrences] = [...parNom.entries()].sort((a, b) => b[1] - a[1])[0];
  if (offres.length >= 6 && occurrences > offres.length / 3) {
    throw new Error(
      `extraction douteuse : « ${String(nomDominant).slice(0, 40)} » revient ${occurrences} fois sur ${offres.length}`
    );
  }

  return offres;
}

/**
 * Collecte un site de bons plans bâti sur Pepper (Dealabs et ses jumeaux).
 *
 * Deux requêtes, et une carte complète en sortie :
 *
 *   la page de rayon porte le prix, le prix de référence, le marchand,
 *   l'image, la catégorie et la date de fin — mais pas la description ;
 *   le flux RSS du même site porte la description et les caractéristiques,
 *   mais aucun prix de référence.
 *
 * On les réunit par l'identifiant du fil, que le flux laisse à la fin de
 * ses liens. Prendre l'un sans l'autre laissait des cartes sans remise ou
 * sans texte ; c'est la seule raison de faire deux appels.
 */
async function collecterPepper(cible) {
  const origine = new URL(cible.promoUrl).origin;
  const hote = new URL(cible.promoUrl).hostname;

  const page = await naviguer(cible.promoUrl, { ms: 25000 });
  if (!page.texte) throw new Error(`page indisponible (HTTP ${page.code})`);

  const fils = extraireFils(page.texte);
  if (fils.length === 0) throw new Error("aucun bon plan lisible sur la page");

  const offres = fils
    .map((f) => offreDePepper(f, { hote, hoteImages: hoteImagesPepper(hote) }))
    .filter(Boolean);

  // Les descriptions sont un bonus : si le flux ne répond pas, on publie
  // sans plutôt que de perdre toutes les offres déjà récupérées.
  const textes = await descriptionsDuFlux(origine).catch(() => new Map());
  for (const o of offres) {
    const t = textes.get(o.externalId);
    if (!t) continue;
    o.description = t.description;
    o.caracteristiques = t.caracteristiques;
    if (!o.url && t.url) o.url = t.url;
  }
  return offres;
}

/** Le serveur d'images d'un site Pepper porte le préfixe « static-pepper ». */
function hoteImagesPepper(hote) {
  return `static-pepper.${hote.replace(/^www\./, "")}`;
}

/**
 * Descriptions du flux RSS d'un site Pepper, indexées par identifiant de fil.
 *
 * L'identifiant est le nombre qui termine l'adresse d'un bon plan
 * (« …-titre-3398373 ») : c'est la seule clé commune entre le flux et la
 * page, qui ne partagent aucun autre champ fiable.
 */
async function descriptionsDuFlux(origine) {
  const rep = await fetch(`${origine}/rss`, {
    headers: { "User-Agent": AGENT },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!rep.ok) return new Map();

  const offres = await parseFluxRSS(await rep.text());
  const index = new Map();
  for (const o of offres) {
    const m = String(o.url || o.externalId || "").match(/(\d{5,})\s*$/);
    if (m) index.set(m[1], { description: o.description, caracteristiques: o.caracteristiques, url: o.url });
  }
  return index;
}

/**
 * Collecte la page « promotions » publique d'une enseigne.
 *
 * Un seul appel réseau rapporte tous les articles que la page annonce,
 * lus dans le balisage schema.org que le marchand publie pour Google.
 * C'est ce qui rend une centaine d'enseignes tenable : une requête par
 * enseigne et par scan, au lieu d'une par article.
 *
 * Firecrawl sert de navigateur quand il est configuré — beaucoup de pages
 * de rayon ne rendent leur balisage qu'après exécution du JavaScript.
 * Sans clé, on tente la page en direct, ce qui suffit sur les sites rendus
 * côté serveur.
 */
async function collecterPagePromo(cible) {
  let html = null;

  if (cleFirecrawl()) {
    // onlyMainContent retirerait le <head>, où vit le JSON-LD.
    const donnees = await appelFirecrawl("/scrape", {
      url: cible.promoUrl,
      formats: ["rawHtml"],
      onlyMainContent: false,
    });
    html = donnees.rawHtml || null;
  } else {
    const rep = await naviguer(cible.promoUrl, { ms: 20000 });
    if (!rep.texte) throw new Error(`page promotions indisponible (HTTP ${rep.code})`);
    html = rep.texte;
  }

  const fiches = html ? produitsDepuisHtml(html) : [];
  if (fiches.length === 0) throw new Error("aucune fiche produit balisée sur la page");

  const base = cible.promoUrl;
  return fiches.map((f, i) => ({
    // Le SKU du marchand est l'identifiant le plus stable ; à défaut le
    // lien, à défaut le nom — sans quoi chaque scan republierait tout.
    externalId: String(f.sku || f.url || `${cible.id}-${f.nom}`).slice(0, 200),
    name: String(f.nom).slice(0, 200),
    price: f.prix,
    refPriceAnnonce: f.prixReference,
    url: lienAbsolu(f.url, base) || base,
    seller: cible.merchant || f.marque || null,
    img: lienAbsolu(f.image, base),
    description: f.description || null,
    caracteristiques: f.caracteristiques || [],
    itemCondition: f.etat || "neuf",
    finOffre: f.finOffre || null,
    debutOffre: f.debutOffre || null,
    balisage: f.source,
    ordre: i,
  }));
}

/** Une page de rayon donne souvent des liens relatifs ; le flux public non. */
function lienAbsolu(lien, base) {
  if (!lien) return null;
  try {
    return new URL(String(lien), base).toString();
  } catch {
    return null;
  }
}

/** Le canal de collecte d'une cible, selon ce qu'elle sait fournir. */
function collecterCible(cible) {
  if (cible.feedUrl) return collecterFlux(cible);
  // La page promotions passe avant la recherche : un appel qui rapporte
  // vingt articles vaut mieux que sept appels qui en rapportent six.
  // Les sites Pepper ont leur propre lecteur : ils ne balisent pas leurs
  // pages en schema.org, mais y embarquent bien mieux que ça.
  // Le catalogue passe en premier : c'est le canal dont les anomalies sont
  // les nôtres, mesurées et non rapportées.
  // Le catalogue d'affiliation passe devant : ses liens mènent à la fiche
  // produit du marchand, ce qu'aucun autre canal ne garantit.
  if (cible.awinFeeds) return collecterAwin(cible);
  if (cible.catalogueUrl) return collecterCatalogue(cible);
  if (cible.promoUrl && estPepper(cible.promoUrl)) return collecterPepper(cible);
  if (cible.promoUrl) return collecterPagePromo(cible);
  if (cible.searchDomains && cible.searchDomains.length > 0) return collecterFirecrawl(cible);
  return Promise.reject(new Error("ni flux, ni catalogue, ni page promotions, ni domaines de recherche"));
}

/**
 * Catalogue produits d'un ou plusieurs marchands, via le réseau d'affiliation.
 *
 * C'est le canal le plus riche : description, EAN, prix conseillé, image, et
 * surtout un lien qui mène VRAIMENT sur la fiche produit du marchand — ce
 * qu'aucun autre canal ne donne quand l'offre nous vient d'un agrégateur.
 *
 * Le fichier est un CSV gzippé qui pèse couramment plusieurs dizaines de
 * mégaoctets par marchand ; l'échantillon se prend donc sur les lignes, avant
 * de construire le moindre objet — voir plus bas.
 */
async function collecterAwin(cible) {
  if (!process.env.AWIN_FEED_KEY) {
    throw new Error("AWIN_FEED_KEY absente — catalogue d'affiliation indisponible");
  }
  const feeds = String(cible.awinFeeds || "").split(",").map((f) => f.trim()).filter(Boolean);
  if (!feeds.length) throw new Error("aucun identifiant de flux Awin sur cette cible");

  const rep = await fetch(urlCatalogue(feeds), { signal: AbortSignal.timeout(120000) });
  if (!rep.ok) throw new Error(`catalogue Awin : HTTP ${rep.status}`);

  /* Le flux arrive gzippé. fetch le décompresse seul quand le serveur
     annonce Content-Encoding: gzip ; Awin sert un .gz par le chemin d'URL
     sans l'annoncer, il faut donc le défaire à la main. */
  const brut = Buffer.from(await rep.arrayBuffer());
  const gzip = brut[0] === 0x1f && brut[1] === 0x8b;
  const csv = (gzip ? zlib.gunzipSync(brut) : brut).toString("utf8");

  const lignes = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lignes.length < 2) throw new Error("catalogue Awin vide ou illisible");
  const corps = lignes.slice(1);

  /* L'échantillon se prend sur les LIGNES, avant de construire le moindre
     objet. Un catalogue de marchand compte couramment des centaines de
     milliers de références : les convertir toutes pour n'en garder que
     soixante ferait passer le processus — celui-là même qui sert le site —
     de quelques mégaoctets à plus d'un gigaoctet.

     Un pas régulier plutôt qu'une tranche de tête : on parcourt tout le
     catalogue au lieu de ne voir que son début, et le pas étant déterministe,
     on retombe d'un passage à l'autre sur à peu près les mêmes produits —
     ce qu'il faut pour qu'un historique de prix se construise. */
  const pas = Math.max(1, Math.floor(corps.length / FICHES_PAR_PASSAGE));
  const echantillon = [lignes[0]];
  for (let i = 0; i < corps.length && echantillon.length <= FICHES_PAR_PASSAGE; i += pas) {
    echantillon.push(corps[i]);
  }

  const offres = offresDuCatalogue(echantillon.join("\n"));
  if (!offres.length) {
    /* « Illisible » ne dit pas pourquoi, et les dix cibles semées ont toutes
       échoué sur ce message. Le début du fichier tranche entre les deux
       explications possibles : un CSV dont l'en-tête a changé, ou un refus
       d'Awin servi en HTTP 200 avec un corps en clair. On ne montre que
       l'en-tête — l'adresse, elle, porte la clé et n'a rien à faire dans un
       journal. */
    throw new Error(`catalogue Awin illisible — début du fichier : « ${lignes[0].slice(0, 180)} »`);
  }

  // Une référence en rupture n'est pas une affaire. On ne l'écarte qu'ici :
  // la disponibilité n'est lisible qu'une fois la ligne convertie.
  const enStock = offres.filter((o) => o.disponible !== false);
  const retenues = enStock.length ? enStock : offres;

  console.log(
    `[awin] ${cible.merchant || feeds.join(",")} : ${corps.length} référence(s) au catalogue, ` +
    `${retenues.length} relevée(s) ce passage.`
  );
  return retenues;
}

/**
 * Désactive les cibles « page promotions » d'enseignes, qui échouent toutes.
 *
 * Vingt-huit avaient été créées à partir de chemins devinés. Sondées une à
 * une : douze répondent 403, six n'existent pas, dix chargent leurs produits
 * en JavaScript. Zéro produit extrait, et vingt-neuf erreurs à chaque scan —
 * de quoi noyer les vraies pannes dans le bruit.
 *
 * Le semis ne les crée plus, mais celles déjà en base continuaient de
 * tourner. On les met en pause plutôt que de les supprimer : leur historique
 * de scans reste lisible, et une adresse un jour vérifiée pourra les
 * réactiver.
 *
 * Reconnaissables à leur `promo_url`, qui pointe sur un domaine du registre.
 */
function desactiverCiblesMortes() {
  const domaines = new Set(MARCHANDS.map((m) => m.domaine.toLowerCase()));
  const actives = db
    .prepare("SELECT id, promo_url FROM watch_targets WHERE active = 1 AND promo_url IS NOT NULL")
    .all();

  let arretees = 0;
  for (const c of actives) {
    const h = hote(c.promo_url);
    if (!h) continue;
    const parts = h.split(".");
    const connu = parts.some((_, i) => domaines.has(parts.slice(i).join(".")));
    if (!connu) continue;
    db.prepare("UPDATE watch_targets SET active = 0 WHERE id = ?").run(c.id);
    arretees++;
  }
  return { arretees };
}

/**
 * Répare les liens des offres déjà publiées qui pointent vers un agrégateur.
 *
 * La règle « jamais vers l'agrégateur » s'applique à la publication, donc
 * aux offres que le prochain scan touchera. Les autres — celles dont
 * l'annonce a disparu de la source entre-temps — resteraient en base avec
 * leur ancien lien, et personne n'a de moyen simple de les corriger :
 * seize d'entre elles renvoyaient encore chez Dealabs après le correctif.
 *
 * On réécrit ce qu'on peut à partir du marchand déjà enregistré, et on
 * retire de la publication ce qu'on ne peut pas réparer. Une offre qu'on
 * ne sait pas atteindre n'a rien à faire sur le site.
 *
 * Idempotent : la seconde exécution ne trouve plus rien.
 */
/**
 * Dépublie les fausses erreurs de prix nées d'une extraction cassée.
 *
 * Vingt-cinq offres ont été publiées sous le nom « Accueil », avec un prix
 * de référence commun et des remises jusqu'à −93 %. Elles ne disparaîtront
 * pas d'elles-mêmes : le prochain scan publie de nouvelles lignes sans
 * toucher aux anciennes. Sur un site qui promet de repérer les erreurs de
 * prix, en laisser d'inventées coûte plus que tout le reste.
 */
function retirerOffresMalNommees() {
  const suspects = db
    .prepare(
      `SELECT title, COUNT(*) AS n FROM deals
       WHERE detector = 'D3' AND published_at IS NOT NULL AND removed_at IS NULL
       GROUP BY title HAVING n >= 5`
    )
    .all();

  let retirees = 0;
  for (const s of suspects) {
    const r = db
      .prepare("UPDATE deals SET removed_at = datetime('now') WHERE detector = 'D3' AND title = ? AND removed_at IS NULL")
      .run(s.title);
    retirees += r.changes;
  }
  return { titres: suspects.length, retirees };
}

/**
 * Retire les remises fabriquées par l'ancien calcul de référence.
 *
 * Jusqu'au 23 août 2026, une offre au prix stable dont l'historique portait
 * une seule lecture fautive héritait de cette lecture comme prix de
 * référence — les relevés corrects étaient écartés parce qu'ils valaient le
 * prix du jour. Le site a ainsi publié « 15,98 € au lieu de 48 € » sur un
 * casque vendu 15 à 18 € partout.
 *
 * Le calcul est corrigé, mais les offres déjà publiées gardent leur fausse
 * référence : rien ne les repasse en revue, `markMissingAsRemoved` ne
 * concernant que les flux. On les retire donc une fois. Celles qui sont de
 * vraies affaires seront redétectées au prochain scan, avec une référence
 * cette fois défendable.
 *
 * Ne vise que les références calculées par nous (« mesure ») : un prix barré
 * annoncé par un marchand n'est pas concerné par ce défaut.
 */
function retirerRemisesFabriquees() {
  const lignes = db
    .prepare(
      `SELECT id, payload FROM deals
       WHERE detector = 'D3' AND published_at IS NOT NULL AND removed_at IS NULL
         AND reference_price IS NOT NULL`
    )
    .all();

  let retirees = 0;
  const retirer = db.prepare("UPDATE deals SET removed_at = datetime('now') WHERE id = ?");
  for (const l of lignes) {
    let source = null;
    try {
      source = JSON.parse(l.payload || "{}").refSource;
    } catch {
      source = null;
    }
    if (source !== "mesure") continue;
    retirer.run(l.id);
    retirees += 1;
  }
  return { examinees: lignes.length, retirees };
}

/**
 * Publie les codes promo et promotions du réseau d'affiliation.
 *
 * Le type « code » existait en base depuis l'origine sans jamais être
 * alimenté : le site promettait des codes promo qu'il n'a jamais eus.
 *
 * Ces offres échappent à la règle « démontrer un avantage » qui s'applique
 * aux produits, et c'est volontaire : un code de réduction EST l'avantage.
 * Il porte sa propre valeur dans son intitulé (« 10 % sur… »), sans prix de
 * référence à comparer.
 */
async function collecterPromotionsAwin() {
  if (!process.env.AWIN_API_TOKEN || !process.env.AWIN_PUBLISHER_ID) return [];

  /* On interroge TOUT le réseau, pas seulement les programmes rejoints — il
     n'y en a aucun, et attendre les validations laisserait la promesse
     « codes promo » vide pendant des semaines. Mesuré : 0 promotion sur les
     programmes rejoints, plus de 200 sur l'ensemble du réseau.

     Mais les conditions d'Awin réservent les liens de tracking aux
     programmes rejoints. On ne les emploie donc QUE là où on y a droit ;
     ailleurs, le lien est reconstruit vers l'accueil du marchand comme il
     l'est déjà pour les offres venues d'un agrégateur.

     Un code promo reste entier sans lien profond : il s'emploie au moment
     de payer, sur le site du marchand. Ce qui compte est le code, l'enseigne
     et la date de fin — et tout cela, on l'a. */
  const rejoints = new Set();
  try {
    for (const p of await programmesRejointsAwin()) rejoints.add(String(p.id));
  } catch {
    // Sans la liste, on considère qu'aucun n'est rejoint : le repli est sûr.
  }

  const offres = await promotionsAwin({ membership: "all" });
  if (!offres.length) return [];

  /* Le réseau est relu en entier à chaque passage : ce qui n'y est plus, ou
     ce que le nettoyage écarte désormais, doit disparaître du site. Sans ce
     retrait, les promotions expirées et celles publiées avant l'affinage des
     règles resteraient en ligne indéfiniment — rien d'autre ne les repasse
     en revue. Elles sont retirées d'abord, republiées ensuite. */
  db.prepare(
    "UPDATE deals SET removed_at = datetime('now') WHERE source = 'awin-promos' AND removed_at IS NULL"
  ).run();

  const publiees = [];
  for (const o of offres) {
    if (!rejoints.has(String(o.advertiserId))) {
      const domaine = domaineDeMarchand(o.seller);
      if (!domaine) continue; // enseigne inconnue : aucun lien honnête à offrir
      o.url = `https://www.${domaine}/`;
      o.lienType = "marchand";
    }
    const id = upsertDeal({
      source: "awin-promos",
      externalId: o.externalId,
      detector: "D2",
      type: o.typePromo,
      title: o.name,
      description: o.description,
      url: o.url,
      merchant: o.seller,
      voucherCode: o.voucherCode,
      startsAt: o.startsAt,
      expiresAt: o.expiresAt,
      payload: {
        requete: "Codes promo Awin",
        lienType: o.lienType,
        marchandDomaine: domaineDeMarchand(o.seller),
      },
    });
    // upsertDeal retrouve la ligne par (source, external_id) : republier
    // remet removed_at à zéro sur celles qui sont toujours valables.
    db.prepare("UPDATE deals SET removed_at = NULL WHERE id = ?").run(id);
    publierDeal(id);
    publiees.push(id);
  }
  return publiees;
}

/**
 * Retire les offres publiées qui ne démontrent aucun avantage.
 *
 * Mesuré le 23 août 2026 : sur 126 offres en ligne, 44 % n'avaient aucun
 * prix de référence — donc aucune remise démontrable — et la totalité était
 * enregistrée en type « produit », c'est-à-dire ni erreur de prix ni
 * promotion mesurée. Un site de bons plans dont les bons plans n'en sont pas
 * ne se rattrape pas sur le volume.
 *
 * La règle de publication est corrigée, mais rien ne repasse en revue ce qui
 * est déjà en ligne. On le fait une fois ; ce qui mérite d'y être sera
 * republié au prochain scan.
 */
function retirerOffresSansAvantage(remiseMin) {
  const seuil = Number.isFinite(remiseMin) ? remiseMin : reglages().remiseMinPromo;
  const info = db
    .prepare(
      `UPDATE deals SET removed_at = datetime('now')
       WHERE detector = 'D3' AND published_at IS NOT NULL AND removed_at IS NULL
         AND (
           -- Sans référence utilisable, il n'y a rien à montrer au visiteur,
           -- et cela vaut aussi pour une anomalie : « erreur de prix » sans
           -- prix barré ne prouve rien à celui qui lit la carte.
           reference_price IS NULL
           OR reference_price <= price
           OR (
             type NOT IN ('erreur', 'promo')
             AND (1.0 - price / reference_price) * 100 < ?
           )
         )`
    )
    .run(seuil);
  return { retirees: info.changes, seuil };
}

function reparerLiensAgregateur() {
  const lignes = db
    // `removed_at IS NULL` rend l'opération vraiment idempotente : sans
    // cette clause, les offres retirées faute de lien étaient réexaminées
    // et « retirées » à nouveau à chaque démarrage.
    .prepare(
      `SELECT id, title, merchant, url FROM deals
       WHERE url IS NOT NULL AND published_at IS NOT NULL AND removed_at IS NULL`
    )
    .all()
    .filter((l) => estPepper(l.url));

  let repares = 0;
  let retires = 0;

  // Même raisonnement pour les offres du moteur publiées sans aucun lien,
  // avant que celui-ci ne devienne obligatoire : elles occupent une place
  // sur la page d'accueil sans mener nulle part. Restreint au détecteur D3
  // pour ne pas toucher aux deals proposés par les membres.
  const sansLien = db
    .prepare("SELECT id FROM deals WHERE detector = 'D3' AND published_at IS NOT NULL AND removed_at IS NULL AND (url IS NULL OR url = '')")
    .all();
  for (const l of sansLien) {
    db.prepare("UPDATE deals SET removed_at = datetime('now') WHERE id = ?").run(l.id);
    retires++;
  }

  for (const l of lignes) {
    const lien = sortieMarchand({
      marchand: l.merchant ? marchandDepuisTexte(l.merchant) : null,
      titre: l.title,
    }).url;
    if (lien) {
      db.prepare("UPDATE deals SET url = ? WHERE id = ?").run(lien, l.id);
      repares++;
    } else {
      db.prepare("UPDATE deals SET removed_at = datetime('now') WHERE id = ?").run(l.id);
      retires++;
    }
  }
  return { examinees: lignes.length + sansLien.length, repares, retires };
}

/* Sites de bons plans bâtis sur Pepper. Leur page d'accueil porte une
   cinquantaine d'offres avec prix de référence, marchand, image et date de
   fin — mesuré : 53 offres dont 34 avec référence, contre 30 offres et zéro
   référence dans le flux RSS du même site.

   Ce canal rapporte ce qu'une communauté a déjà qualifié d'affaire. Utile,
   mais ce ne sont pas nos données : c'est un dépannage, pas une fondation. */
const SOURCES_COMMUNAUTAIRES = [
  { nom: "Bons plans Dealabs", url: "https://www.dealabs.com/" },
];

/* Marchands dont le catalogue est parcourable par leur propre sitemap, et
   dont les fiches portent un balisage schema.org lisible.

   La liste n'est pas choisie, elle est mesurée : les quatre-vingt-quatre
   enseignes du registre ont été sondées le 23 août 2026 — robots.txt,
   sitemaps, puis quatre fiches tirées au hasard dans le catalogue. La
   plupart refusent tout robot (403 Cloudflare, DataDome) ou n'exposent
   aucun sitemap. Celles-ci ont répondu :

     LDLC          78 667 fiches listées   6/6 fiches lues
     JouéClub      40 001                  4/4
     Ikea           4 526                  4/4
     Electro Dépôt  2 915                  4/4
     N&D              107                  4/4

   C'est le seul canal dont les anomalies seront les nôtres. */
const CATALOGUES_MARCHANDS = [
  { nom: "LDLC", racine: "https://www.ldlc.com", categorie: "hightech" },
  { nom: "JouéClub", racine: "https://www.joueclub.fr", categorie: "tout" },
  { nom: "Electro Dépôt", racine: "https://www.electrodepot.fr", categorie: "maison" },
  { nom: "Nature & Découvertes", racine: "https://www.natureetdecouvertes.com", categorie: "tout" },
  /* Ajoutés le 24 août 2026 sur relevé de la sonde, depuis l'IP qui
     collecte : chacun rend 3 fiches sur 3 avec un prix. Ils étaient
     lisibles avant, et personne ne le savait — le relevé du 22 août, qui
     n'en voyait que cinq sur quatre-vingt-quatre, avait été fait ailleurs.
     Boulanger et E.Leclerc ne sont pas des marchands de niche. */
  { nom: "Boulanger", racine: "https://www.boulanger.com", categorie: "hightech" },
  { nom: "E.Leclerc", racine: "https://www.e.leclerc", categorie: "alimentaire" },
  { nom: "Rue du Commerce", racine: "https://www.rueducommerce.fr", categorie: "hightech" },
  { nom: "Brico Dépôt", racine: "https://www.bricodepot.fr", categorie: "maison" },
  { nom: "Truffaut", racine: "https://www.truffaut.com", categorie: "maison" },

  /* Les onze qu'on atteint sans savoir les lire. Leurs sitemaps répondent,
     leurs pages arrivent entières, et extraction.js n'y trouve ni
     schema.org, ni microdata, ni OpenGraph exploitable. Ils ne sont
     suivis que parce que lecture.js existe : sans clé Anthropic, ils
     échoueront proprement et le journal le dira, sans rien casser
     d'autre. Ce sont eux qui paieront le repli — et personne d'autre,
     puisque le modèle ne se déclenche que là où le balisage se tait. */
  { nom: "Aldi", racine: "https://www.aldi.fr", categorie: "alimentaire" },
  { nom: "Free", racine: "https://www.free.fr", categorie: "hightech" },
  { nom: "Ikea", racine: "https://www.ikea.com", categorie: "maison" },
  { nom: "Leroy Merlin", racine: "https://www.leroymerlin.fr", categorie: "maison" },
  { nom: "Kiabi", racine: "https://www.kiabi.com", categorie: "mode" },
  { nom: "Vinted", racine: "https://www.vinted.fr", categorie: "mode" },
  { nom: "Marionnaud", racine: "https://www.marionnaud.fr", categorie: "beaute" },
  { nom: "Nocibé", racine: "https://www.nocibe.fr", categorie: "beaute" },
  { nom: "Momox", racine: "https://www.momox-shop.fr", categorie: "tout" },
  { nom: "Feu Vert", racine: "https://www.feuvert.fr", categorie: "auto" },
  { nom: "Midas", racine: "https://www.midas.fr", categorie: "auto" },
];

/**
 * Les catalogues Awin téléchargeables sur le marché français.
 *
 * Relevé en production le 24 août 2026 sur la liste des flux : 583
 * catalogues sont accessibles à notre compte, dont **dix-huit** portent une
 * région ou une langue française. Tous sont en « Not Joined » — un catalogue
 * se télécharge donc sans avoir rejoint le programme, ce qui change tout :
 * on n'attend plus l'accord d'un marchand pour commencer à mesurer.
 *
 * Aucun n'est une enseigne du registre. Ce sont des marchands de niche —
 * parfumerie, luminaire, claviers, soin capillaire — et c'est précisément
 * ce qu'ils apportent : un lien qui mène VRAIMENT sur la fiche produit, un
 * prix conseillé publié par le vendeur, et un catalogue assez petit pour
 * qu'on repasse souvent sur chaque référence. Sur 6 871 références un
 * passage de soixante fiches revient sur chacune tous les quinze jours ;
 * sur 209, toutes les trois heures.
 *
 * Deux flux d'un même annonceur sont réunis sur une seule cible quand ils
 * découpent le même catalogue : `urlCatalogue` sait en demander plusieurs
 * d'un coup, et un seul historique vaut mieux que deux moitiés.
 */
const CATALOGUES_AWIN = [
  { nom: "Perfumeria Comas", feeds: "97867", categorie: "beaute" },
  { nom: "Éclairage Déco", feeds: "116485,116353", categorie: "maison" },
  { nom: "AKKO", feeds: "94349", categorie: "hightech" },
  { nom: "Deluxe Home Art Shop", feeds: "110456", categorie: "maison" },
  { nom: "Woodstore24", feeds: "87242", categorie: "maison" },
  { nom: "Bouclème", feeds: "102042", categorie: "beaute" },
  { nom: "Al Jazeera Perfumes", feeds: "115328", categorie: "beaute" },
  { nom: "ANITA & ZAHA", feeds: "117451", categorie: "mode" },
  { nom: "Bodycross", feeds: "115451", categorie: "sport" },
  { nom: "BlazeVideo", feeds: "89534", categorie: "hightech" },
];

/**
 * Crée les cibles à partir du registre des enseignes.
 *
 * Le site doit se remplir à l'installation, sans que personne saisisse
 * cent domaines. Chaque enseigne qui publie une page « promotions » en
 * devient une, du même nom qu'elle.
 *
 * Idempotent : une cible déjà présente pour la même adresse n'est pas
 * recréée, et une cible que l'administration a désactivée le reste. Le
 * semis peut donc tourner à chaque démarrage sans rien écraser.
 *
 * @param {object} [opts]
 * @param {number} [opts.limite] nombre maximal de cibles à créer d'un coup.
 *   Chaque cible active coûte un appel Firecrawl par scan : mieux vaut
 *   pouvoir borner que découvrir la facture après coup.
 */
function semerCibles({ limite = Infinity } = {}) {
  const existantes = new Set(
    db.prepare("SELECT promo_url FROM watch_targets WHERE promo_url IS NOT NULL").all().map((r) => r.promo_url)
  );

  let creees = 0;

  // Les agrégateurs d'abord : une seule page en rend cinquante d'un coup,
  // avec le prix de référence que les enseignes, elles, ne publient pas.
  // C'est la source qui remplit le site le plus vite et le plus richement.
  for (const source of SOURCES_COMMUNAUTAIRES) {
    if (creees >= limite) break;
    if (existantes.has(source.url)) continue;
    const r = addTarget({ query: source.nom, category: "tout", promoUrl: source.url });
    if (r.ok) creees++;
  }

  // Les catalogues marchands : le canal qui mesure au lieu de rapporter.
  const dejaSuivis = new Set(
    db.prepare("SELECT catalogue_url FROM watch_targets WHERE catalogue_url IS NOT NULL").all().map((r) => r.catalogue_url)
  );
  for (const m of CATALOGUES_MARCHANDS) {
    if (creees >= limite) break;
    if (dejaSuivis.has(m.racine)) continue;
    const r = addTarget({
      query: `Catalogue ${m.nom}`,
      category: m.categorie,
      merchant: m.nom,
      catalogueUrl: m.racine,
    });
    if (r.ok) creees++;
  }

  /* Les catalogues d'affiliation : même mécanique que les catalogues
     marchands, sans dépendre du bon vouloir d'un sitemap. La cible est
     reconnue à ses identifiants de flux, si bien qu'ajouter un flux à un
     marchand déjà suivi crée une cible distincte plutôt que d'écraser son
     historique. */
  const fluxSuivis = new Set(
    db.prepare("SELECT awin_feeds FROM watch_targets WHERE awin_feeds IS NOT NULL").all().map((r) => r.awin_feeds)
  );
  for (const m of CATALOGUES_AWIN) {
    if (creees >= limite) break;
    if (fluxSuivis.has(m.feeds)) continue;
    const r = addTarget({
      query: `Catalogue ${m.nom}`,
      category: m.categorie,
      merchant: m.nom,
      awinFeeds: m.feeds,
    });
    if (r.ok) creees++;
  }

  // Les pages « promotions » des enseignes ne sont plus semées : sondées
  // une à une, aucune ne rend de produit. Douze répondent 403, six
  // n'existent pas, dix chargent leur contenu en JavaScript. Vingt-huit
  // cibles qui échouaient à chaque scan, pour rien. Le champ `promo` du
  // registre reste pour une adresse un jour VÉRIFIÉE.
  return { creees, total: db.prepare("SELECT COUNT(*) AS n FROM watch_targets").get().n };
}

// ── Scan complet ────────────────────────────────────────────────

/* Par quel canal cette cible est-elle collectée. Le journal disait
   « firecrawl » pour tout ce qui n'était pas un flux — les catalogues et les
   cibles Awin s'y retrouvaient rangés sous un nom qui n'était pas le leur, et
   la santé par canal mesurait donc un mélange. */
function canalDe(cible) {
  if (cible.awinFeeds) return "awin";
  if (cible.catalogueUrl) return "catalogue";
  if (cible.feedUrl) return "flux";
  return "firecrawl";
}

/** Une seule exécution à la fois : deux scans simultanés se marcheraient sur les pieds. */
let scanEnCours = false;

/**
 * Passe toutes les cibles actives au crible : collecte → snapshots →
 * analyse (algorithm.js) → publication des anomalies dans `deals` (D3).
 *
 * @param {object} opts
 * @param {number|null} opts.userId auteur du scan (null pour le cron)
 * @param {string} opts.source "manuel" | "cron" | "api"
 * @param {number} [opts.targetId] restreindre à une cible
 */
async function lancerScan({ userId = null, source = "manuel", targetId = null } = {}) {
  const cibles = targetId
    ? (() => {
        const t = getTarget(targetId);
        return t ? [t] : [];
      })()
    : listTargets({ actives: true });

  if (cibles.length === 0) {
    return { runId: null, cibles: 0, offres: 0, analyses: 0, publies: 0, ignorees: 0, erreurs: 0, details: [] };
  }
  if (scanEnCours) {
    throw new Error("Un scan est déjà en cours.");
  }
  scanEnCours = true;
  // Le plafond de lectures se réarme à chaque scan : un budget qui ne se
  // rouvre jamais finirait par tout bloquer sans rien dire.
  lecture.ouvrirBudget();

  const runId = debuterScan(source, cibles.length, userId);
  const bilan = { runId, cibles: cibles.length, offres: 0, analyses: 0, publies: 0, ignorees: 0, erreurs: 0, details: [] };

  try {
    for (const cible of cibles) {
      const ligne = { cible: cible.id, requete: cible.query, offres: 0, publies: 0, ignorees: 0, erreur: null };
      try {
        const offres = await collecterCible(cible);
        if (offres.length === 0) throw new Error("aucune offre exploitable");

        /* On analyse AVANT d'enregistrer, et l'ordre compte.

           Enregistrés d'abord, les relevés du jour entraient dans leur propre
           historique : le lot se comparait à lui-même et tirait la référence
           vers le prix constaté à l'instant, ce qui écrase les baisses
           réelles. algorithm.js compensait en écartant de l'historique toute
           ligne au prix du jour — un remède pire que le mal, qui ne laissait
           que les lectures aberrantes et fabriquait de fausses remises.

           Analyser d'abord règle les deux : l'historique ne contient que le
           passé, et rien n'a besoin d'être filtré. */
        const analyses = analyzeOffers(offres);

        insertSnapshots(cible.query, cible.category, offres);
        const anomalies = analyses.filter((o) => o.verdict !== "normal");

        // Ce qu'on publie dépend de la nature de la cible.
        //
        // Un flux marchand est une liste déjà choisie par sa source : ses
        // articles valent d'être montrés même quand aucune anomalie n'est
        // mesurable. Et c'est le cas général — analyzeOffers a besoin de
        // plusieurs offres du MÊME produit pour établir une référence,
        // alors qu'un flux de bons plans contient cinquante produits
        // différents. Filtrer sur les anomalies y publiait donc zéro
        // article : le site restait vide alors que la collecte marchait.
        //
        // Une cible Firecrawl, elle, existe pour comparer les prix d'un
        // produit précis chez plusieurs marchands. Y publier chaque page
        // visitée noierait la mesure sous les pages ordinaires.
        // Ce qui fait une carte digne d'être montrée, mesuré sur le vrai
        // flux Dealabs plutôt que supposé : marchand et prix y sont déclarés
        // dans 29 articles sur 30, l'image dans 30 sur 30 — mais le prix
        // barré dans AUCUN. Exiger une référence, comme le faisait la règle
        // précédente, écartait donc cent pour cent des articles. C'est ce qui
        // affichait « 29 offres, 0 publiée » en production.
        //
        // La condition porte sur ce qui rend une carte lisible : on sait qui
        // vend, et on a de quoi montrer l'article. Le pourcentage s'affiche
        // quand la référence existe, et se tait sinon — plutôt que de
        // retenir l'article en otage.
        //
        // Règle absolue, appliquée quel que soit le canal et AVANT le tri :
        // on n'envoie jamais l'acheteur chez l'agrégateur qui nous a
        // renseignés. Ce serait lui offrir le visiteur qu'on vient de
        // convaincre, et RadarPrix n'existe pas pour ça.
        //
        // Le test porte sur l'agrégateur, PAS sur « même hôte que la
        // source » : le flux d'un marchand pointe légitimement vers son
        // propre site, et une première version de cette garde effaçait
        // donc les liens des catalogues marchands — exactement ceux qu'il
        // faut suivre.
        for (const a of analyses) {
          if (estPepper(a.url)) {
            const sortie = sortieMarchand({
              marchand: a.seller ? marchandDepuisTexte(a.seller) : null,
              titre: a.name,
            });
            a.url = sortie.url;
            a.lienType = sortie.type;
          }
        }

        /* Ce qu'on accepte d'appeler « deal ».
        
           Mesuré le 23 août 2026 sur les 126 offres alors publiées : 44 %
           n'avaient AUCUN prix de référence, donc aucune remise démontrable,
           et 100 % étaient enregistrées en type « produit » — pas une seule
           erreur de prix ni promotion mesurée. Le site présentait donc des
           articles ordinaires comme des affaires, et sa page « Erreurs de
           prix » restait vide tout en annonçant cent trente-quatre deals.

           La règle précédente ne demandait qu'une carte lisible : un
           marchand, un lien, une image. C'était le bon critère pour REMPLIR
           la page, pas pour mériter d'y figurer. Un site de bons plans dont
           les bons plans n'en sont pas ne se rattrape pas sur le volume.

           Une offre est donc retenue si elle démontre un avantage :
             · une anomalie que nous avons mesurée (erreur ou deal), ou
             · une remise annoncée par le marchand d'au moins `remiseMinPromo`.
           Une image et un vendeur restent nécessaires, mais ne suffisent
           plus. */
        const remiseAnnoncee = (a) => {
          const ref = a.refPrice ?? a.refPriceAnnonce;
          if (!ref || !Number.isFinite(a.price) || a.price <= 0 || ref <= a.price) return 0;
          return Math.round((1 - a.price / ref) * 100);
        };

        /* Actionnable : on sait qui vend et où cliquer. En dessous, ce n'est
           pas une offre mais une frustration — quel que soit l'intérêt du
           prix. */
        const actionnable = (a) => Boolean(a.seller) && Boolean(a.url);

        /* Une anomalie que NOUS avons mesurée est la raison d'être du site :
           elle passe sans avoir à être jolie. Une promotion simplement
           annoncée par un marchand doit, elle, valoir le détour et pouvoir
           être présentée. */
        const meriteLaUne = (a) => {
          if (!actionnable(a)) return false;
          /* Une anomalie sans référence affichable n'en est pas une pour le
             lecteur : la carte annonce une affaire et ne montre aucun prix
             barré. Le premier passage sur le catalogue Bouclème a publié
             ainsi un « Cardboard tube LID (white) » à dix centimes — un
             emballage, décrété anormal parce qu'il l'est en effet, mais sans
             rien à opposer au visiteur. C'est le défaut des 44 % d'offres
             sans référence qui revenait par une autre porte. */
          if (a.verdict !== "normal") return Boolean(a.refPrice ?? a.refPriceAnnonce);
          return (
            remiseAnnoncee(a) >= R_PUBLICATION().remiseMinPromo &&
            Boolean(a.img || a.description)
          );
        };

        /* Les cibles Firecrawl restent sur les seules anomalies : elles
           visitent des fiches ordinaires pour établir une référence, et
           publier chaque page visitée noierait la mesure. */
        const listeChoisie = Boolean(cible.feedUrl || cible.promoUrl || cible.awinFeeds);
        const retenues = listeChoisie ? analyses.filter(meriteLaUne) : anomalies.filter(actionnable);
        const ignorees = analyses.length - retenues.length;
        const aPublier = retenues;

        let publies = 0;
        for (const a of aPublier) {

          const id = upsertDeal({
            source: `d3-${cible.id}`,
            externalId: a.externalId,
            detector: "D3",
            // « produit » désigne un article rapporté sans anomalie mesurée.
            // Le frontend le rend en « deal » comme une promotion, et ne le
            // fait jamais passer pour une erreur de prix : seul le type
            // « erreur » alimente cette page et cette promesse.
            type: a.verdict === "erreur" ? "erreur" : a.verdict === "deal" ? "promo" : "produit",
            title: a.name,
            price: a.price,
            // Deux références possibles, et elles ne valent pas la même
            // chose : celle que RadarPrix a mesurée entre marchands prime
            // sur celle que la source annonce. Un prix barré est un
            // argument de vente ; une médiane observée est un constat.
            referencePrice: a.refPrice ?? a.refPriceAnnonce ?? null,
            url: a.url,
            imageUrl: a.img || null,
            merchant: a.seller || cible.merchant || null,
            // La catégorie de l'article prime : un flux généraliste porte
            // du high-tech et de l'alimentaire, et tout ranger sous la
            // catégorie de la cible rendrait les filtres du site inutiles.
            category: a.category || cible.category,
            itemCondition: a.itemCondition || "neuf",
            // La description vient de la fiche du marchand ; on la borne
            // parce qu'une fiche peut contenir une page entière.
            description: a.description ? String(a.description).slice(0, 1200) : null,
            // Durée de l'offre telle que le marchand la déclare
            // (priceValidUntil / validThrough). Le flux public l'expose,
            // et dealsStore retire d'office une offre expirée.
            startsAt: a.debutOffre || null,
            expiresAt: a.finOffre || null,
            score: a.score,
            confidence: a.confidence,
            payload: {
              requete: cible.query,
              pct: a.pct,
              priceTotal: a.priceTotal,
              allTimeLow: Boolean(a.allTimeLow),
              zScore: a.zScore ?? null,
              // D'où vient le prix barré affiché. Le site n'a pas le droit
              // de présenter la promesse d'un marchand comme sa propre
              // mesure : c'est toute la différence qu'il vend.
              refSource: a.refPrice ? "mesure" : a.refPriceAnnonce ? "flux" : null,
            // Sur quoi cette référence repose : « marche » (plusieurs
            // marchands l'ont pratiquée) ou « marchand » (le passé d'une
            // seule enseigne). L'interface annonçait « prix habituel chez
            // les autres vendeurs » dans les deux cas.
            baseReference: a.baseReference || null,
            marchandsComparés: a.marchandsComparés || 0,
              // Caractéristiques déclarées (additionalProperty schema.org) :
              // « Autonomie : 30 heures », « Couleur : noir ». C'est ce qui
              // distingue une fiche produit d'une ligne de prix.
              caracteristiques: a.caracteristiques && a.caracteristiques.length ? a.caracteristiques : null,
              // D'où vient l'information : jsonld, microdata, opengraph,
              // texte. Permet de mesurer la qualité du balisage marchand
              // par marchand plutôt que de la supposer.
              balisage: a.balisage || null,
              // Ce que le lien ouvre vraiment. Annoncer « Voir le produit »
              // pour aboutir sur une page de résultats trompe le lecteur.
              // Pas de repli optimiste : un canal qui ne dit pas ce qu'il
              // ouvre n'ouvre pas une fiche produit. Le supposer a fait
              // annoncer « Voir le produit » sur des liens de recherche.
              lienType: a.lienType || null,
              // Domaine de l'enseigne, pour afficher son logo plutôt que
              // son initiale.
              // Le catalogue d'affiliation connaît le domaine du vendeur ;
              // le registre ne connaît que les enseignes qu'on y a mises.
              // On préfère donc ce que la source affirme à ce qu'on devine.
              marchandDomaine: a.marchandDomaine || domaineDeMarchand(a.seller || cible.merchant),
            },
          });
          publierDeal(id);
          publies++;
        }

        // Un flux est une liste complète : une offre qui n'y figure plus a
        // disparu de la vente et doit cesser d'être servie.
        if (cible.feedUrl) {
          markMissingAsRemoved(`d3-${cible.id}`, offres.map((o) => String(o.externalId)));
        }

        bilan.offres += offres.length;
        // « analyses » compte les anomalies, pas les articles parcourus :
        // c'est le chiffre que le tableau de bord présente comme détections.
        bilan.analyses += anomalies.length;
        bilan.publies += publies;
        bilan.ignorees += ignorees;
        ligne.offres = offres.length;
        ligne.publies = publies;
        ligne.ignorees = ignorees;
        // Le nombre d'articles écartés part dans le journal de la source :
        // un flux qui ne publie rien doit dire pourquoi, sinon on retombe
        // sur un site vide dont la collecte a l'air de marcher.
        logSourceEvent(
          canalDe(cible),
          true,
          `${cible.query} : ${offres.length} offre(s), ${publies} publiée(s)` +
            // « ou » et non « ni » : il suffit qu'une des deux manque.
            (ignorees > 0 ? `, ${ignorees} écartée(s) faute de vendeur ou de visuel` : "")
        );
      } catch (e) {
        bilan.erreurs++;
        ligne.erreur = e.message;
        logSourceEvent(canalDe(cible), false, `${cible.query} : ${e.message}`);
        /* Et sur la sortie standard, pas seulement dans source_events : un
           bilan qui annonce « 10 erreur(s) » sans dire lesquelles oblige à
           ouvrir la base pour savoir ce qui s'est cassé. */
        console.error(`[scan] ${cible.query} (${canalDe(cible)}) : ${e.message}`);
      }
      bilan.details.push(ligne);
    }

    /* Les codes promo du réseau d'affiliation, hors boucle : c'est un appel
       unique au réseau et non un relevé par produit. Ces offres n'ont pas de
       prix — une réduction n'est pas un tarif — et ne passent donc pas par
       l'analyse de prix. Elles apportent en revanche ce qui manquait le plus
       au site : un lien qui mène vraiment chez le marchand. */
    try {
      const promos = await collecterPromotionsAwin();
      bilan.offres += promos.length;
      bilan.publies += promos.length;
      if (promos.length) console.log(`[awin] ${promos.length} code(s) promo publié(s).`);
    } catch (e) {
      bilan.erreurs++;
      logSourceEvent("awin", false, `promotions : ${e.message}`);
    }
  } finally {
    scanEnCours = false;
  }

  /* Publication sur Telegram, en fin de cycle et hors du try/finally qui
     protège le scan. publierNouveautes() ne lève jamais — le double filet
     est volontaire : une collecte réussie ne doit pas être marquée en échec
     parce qu'un canal de diffusion est tombé. */
  try {
    await publierNouveautes();
  } catch (e) {
    console.error(`[telegram] non publié : ${e.message}`);
  }

  terminerScan(runId, {
    okCount: cibles.length - bilan.erreurs,
    failCount: bilan.erreurs,
    offersCount: bilan.offres,
    error: bilan.erreurs > 0 ? `${bilan.erreurs} cible(s) en échec` : null,
  });
  return bilan;
}

/**
 * État des canaux de collecte, lu directement dans source_events.
 * Miroir de sourceHealth() (db.js) pour les sources qui vivent ici :
 * « flux » (RSS/feeds) et « firecrawl » (SaaS).
 */
function etatCollecte() {
  return ["flux", "firecrawl"].map((source) => {
    const dernier = (ok) =>
      db
        .prepare("SELECT created_at, detail FROM source_events WHERE source = ? AND ok = ? ORDER BY id DESC LIMIT 1")
        .get(source, ok);
    const recents = db.prepare("SELECT ok FROM source_events WHERE source = ? ORDER BY id DESC LIMIT 50").all(source);
    let serieEchecs = 0;
    for (const e of recents) {
      if (e.ok === 1) break;
      serieEchecs++;
    }
    const sur24h = db
      .prepare(
        `SELECT SUM(ok) AS succes, COUNT(*) AS total FROM source_events
         WHERE source = ? AND created_at > datetime('now', '-1 day')`
      )
      .get(source);
    const succes = dernier(1);
    const echec = dernier(0);
    return {
      source,
      dernierSucces: succes?.created_at || null,
      dernierEchec: echec?.created_at || null,
      dernierMessage: echec?.detail || null,
      // Un scan qui réussit peut n'avoir rien publié. Sans ce message, le
      // panneau afficherait « opérationnel » devant un site vide.
      dernierBilan: succes?.detail || null,
      serieEchecs,
      etat: recents.length === 0 ? "inconnu" : serieEchecs === 0 ? "ok" : serieEchecs >= 5 ? "panne" : "instable",
      appels24h: sur24h?.total || 0,
      succes24h: sur24h?.succes || 0,
    };
  });
}

module.exports = {
  listTargets,
  getTarget,
  addTarget,
  semerCibles,
  desactiverCiblesMortes,
  reparerLiensAgregateur,
  retirerOffresMalNommees,
  retirerRemisesFabriquees,
  retirerOffresSansAvantage,
  updateTarget,
  deleteTarget,
  parseFluxRSS,
  parseFluxXML,
  extrairePrix,
  prixReference,
  collecterFlux,
  collecterFirecrawl,
  collecterCible,
  collecterAwin,
  collecterPromotionsAwin,
  lancerScan,
  etatCollecte,
};
