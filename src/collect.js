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
const { db, insertSnapshots, debuterScan, terminerScan, logSourceEvent } = require("./db");
const { analyzeOffers } = require("./algorithm");
const { upsertDeal, publierDeal, markMissingAsRemoved } = require("./dealsStore");
const { MARCHANDS, reconnaitreMarchand, pagePromo } = require("./marchands");
const { produitDepuisHtml, produitsDepuisHtml } = require("./extraction");
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
function addTarget({ query, category, merchant, feedUrl, promoUrl, domains }) {
  const propre = String(query || "").trim();
  if (propre.length < 3) return { ok: false, error: "Le produit suivi doit faire au moins 3 caractères." };
  const flux = feedUrl ? String(feedUrl).trim() : "";
  const promo = promoUrl ? String(promoUrl).trim() : "";
  const domaines = Array.isArray(domains) ? domains.map((d) => String(d).trim()).filter(Boolean) : [];
  if (!flux && !promo && domaines.length === 0) {
    return { ok: false, error: "Il faut un flux (feedUrl), une page promotions (promoUrl) ou au moins un domaine marchand (domains)." };
  }
  for (const [valeur, quoi] of [[flux, "du flux"], [promo, "de la page promotions"]]) {
    if (valeur && !/^https?:\/\//.test(valeur)) {
      return { ok: false, error: `L'URL ${quoi} doit commencer par http:// ou https://` };
    }
  }
  const info = db
    .prepare(
      `INSERT INTO watch_targets (query, category, merchant, feed_url, promo_url, search_domains)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      propre,
      category || "tout",
      merchant ? String(merchant).trim() : null,
      flux || null,
      promo || null,
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
  if (!feedUrl && domaines.length === 0) {
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

/* « -40% », « −40 % », « (-40%) » : certains flux annoncent la remise sans
   jamais donner le prix d'avant. */
const POURCENT = /[-−–]\s*(\d{1,2})\s*%/;

/**
 * Prix de référence annoncé par la source, ou null.
 *
 * Trois chemins, du plus sûr au moins sûr : une balise de prix barré, une
 * formule explicite, puis un pourcentage dont on retrouve le prix d'avant
 * par le calcul. Une référence inférieure ou égale au prix payé est
 * rejetée : ce n'est pas une remise, c'est une coquille de la source.
 */
function prixReference(texte, prix) {
  if (!Number.isFinite(prix) || prix <= 0) return null;
  const brut = String(texte || "");

  for (const motif of [BARRE_HTML, BARRE_TEXTE]) {
    const m = brut.match(motif);
    const ref = m ? extrairePrix(m[1]) : null;
    if (Number.isFinite(ref) && ref > prix) return ref;
  }

  const pc = brut.match(POURCENT);
  if (pc) {
    const pct = parseInt(pc[1], 10);
    if (pct > 0 && pct < 100) {
      const ref = Math.round((prix / (1 - pct / 100)) * 100) / 100;
      if (ref > prix) return ref;
    }
  }
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

/* Catégories telles que les agrégateurs français les nomment, ramenées aux
   nôtres. Sans cette table, tout un flux atterrissait dans « tout » et les
   filtres du site ne servaient à rien. */
const CATEGORIES_FLUX = [
  [/high[-\s]?tech|informatique|t[ée]l[ée]phon|image\s*&?\s*son|photo/i, "hightech"],
  [/console|jeux?\s*vid[ée]o|gaming|jeu\s*pc/i, "gaming"],
  [/maison|habitat|jardin|bricolage|[ée]lectrom[ée]nager|meuble|d[ée]co/i, "maison"],
  [/mode|accessoire|v[êe]tement|chaussure|bijou|montre/i, "mode"],
  [/beaut[ée]|hygi[èe]ne|parfum|sant[ée]|cosm[ée]tique/i, "beaute"],
  [/course|alimentation|alimentaire|boisson|[ée]picerie|caf[ée]/i, "alimentaire"],
  [/sport|plein\s*air|fitness|v[ée]lo|randonn/i, "sport"],
  [/auto|moto|v[ée]hicule|pneu|garage/i, "auto"],
];

/** Catégorie RadarPrix d'après le libellé de la source, « tout » à défaut. */
function categorieDeFlux(libelles) {
  const texte = [].concat(libelles || []).join(" ");
  for (const [motif, categorie] of CATEGORIES_FLUX) {
    if (motif.test(texte)) return categorie;
  }
  return null;
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
    category: categorieDeFlux(item.categories),
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
    headers: { "User-Agent": "RadarPrix/1.0 (+https://radarprix.fr)" },
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
    const rep = await fetch(cible.promoUrl, {
      headers: { "User-Agent": "RadarPrix/1.0 (+https://radarprix.fr)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!rep.ok) throw new Error(`page promotions indisponible (HTTP ${rep.status})`);
    html = await rep.text();
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
  if (cible.promoUrl) return collecterPagePromo(cible);
  if (cible.searchDomains && cible.searchDomains.length > 0) return collecterFirecrawl(cible);
  return Promise.reject(new Error("ni flux, ni page promotions, ni domaines de recherche"));
}

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
  for (const m of MARCHANDS) {
    if (creees >= limite) break;
    const url = pagePromo(m);
    if (!url || existantes.has(url)) continue;
    const r = addTarget({
      query: `Promotions ${m.nom}`,
      category: m.categorie,
      merchant: m.nom,
      promoUrl: url,
    });
    if (r.ok) creees++;
  }
  return { creees, total: db.prepare("SELECT COUNT(*) AS n FROM watch_targets").get().n };
}

// ── Scan complet ────────────────────────────────────────────────

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

  const runId = debuterScan(source, cibles.length, userId);
  const bilan = { runId, cibles: cibles.length, offres: 0, analyses: 0, publies: 0, ignorees: 0, erreurs: 0, details: [] };

  try {
    for (const cible of cibles) {
      const ligne = { cible: cible.id, requete: cible.query, offres: 0, publies: 0, ignorees: 0, erreur: null };
      try {
        const offres = await collecterCible(cible);
        if (offres.length === 0) throw new Error("aucune offre exploitable");

        insertSnapshots(cible.query, cible.category, offres);

        // La détection elle-même : référence entre pairs du lot + historique
        // en base (voir algorithm.js).
        const analyses = analyzeOffers(offres);
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
        // Une anomalie mesurée échappe au tri : c'est la raison d'être du
        // site, et elle porte sa référence par construction.
        const presentable = (a) =>
          a.verdict !== "normal" ||
          (Boolean(a.seller) && Boolean(a.img || a.description));

        // Un flux et une page « promotions » sont tous deux des listes déjà
        // choisies par le marchand : ce qu'elles annoncent vaut d'être
        // montré. Seule la recherche Firecrawl reste sur les anomalies —
        // elle visite des fiches ordinaires pour établir une référence, et
        // les publier toutes noierait la mesure.
        const listeChoisie = Boolean(cible.feedUrl || cible.promoUrl);
        const retenues = listeChoisie ? analyses.filter(presentable) : anomalies;
        const ignorees = listeChoisie ? analyses.length - retenues.length : 0;
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
              // Caractéristiques déclarées (additionalProperty schema.org) :
              // « Autonomie : 30 heures », « Couleur : noir ». C'est ce qui
              // distingue une fiche produit d'une ligne de prix.
              caracteristiques: a.caracteristiques && a.caracteristiques.length ? a.caracteristiques : null,
              // D'où vient l'information : jsonld, microdata, opengraph,
              // texte. Permet de mesurer la qualité du balisage marchand
              // par marchand plutôt que de la supposer.
              balisage: a.balisage || null,
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
          cible.feedUrl ? "flux" : "firecrawl",
          true,
          `${cible.query} : ${offres.length} offre(s), ${publies} publiée(s)` +
            // « ou » et non « ni » : il suffit qu'une des deux manque.
            (ignorees > 0 ? `, ${ignorees} écartée(s) faute de vendeur ou de visuel` : "")
        );
      } catch (e) {
        bilan.erreurs++;
        ligne.erreur = e.message;
        logSourceEvent(cible.feedUrl ? "flux" : "firecrawl", false, `${cible.query} : ${e.message}`);
      }
      bilan.details.push(ligne);
    }
  } finally {
    scanEnCours = false;
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
  updateTarget,
  deleteTarget,
  parseFluxRSS,
  parseFluxXML,
  extrairePrix,
  prixReference,
  collecterFlux,
  collecterFirecrawl,
  collecterCible,
  lancerScan,
  etatCollecte,
};
