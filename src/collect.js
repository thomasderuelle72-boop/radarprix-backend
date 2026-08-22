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
function addTarget({ query, category, merchant, feedUrl, domains }) {
  const propre = String(query || "").trim();
  if (propre.length < 3) return { ok: false, error: "Le produit suivi doit faire au moins 3 caractères." };
  const flux = feedUrl ? String(feedUrl).trim() : "";
  const domaines = Array.isArray(domains) ? domains.map((d) => String(d).trim()).filter(Boolean) : [];
  if (!flux && domaines.length === 0) {
    return { ok: false, error: "Il faut un flux (feedUrl) ou au moins un domaine marchand (domains)." };
  }
  if (flux && !/^https?:\/\//.test(flux)) {
    return { ok: false, error: "L'URL du flux doit commencer par http:// ou https://" };
  }
  const info = db
    .prepare(
      `INSERT INTO watch_targets (query, category, merchant, feed_url, search_domains)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(propre, category || "tout", merchant ? String(merchant).trim() : null, flux || null, JSON.stringify(domaines));
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

/** Offre brute d'un flux, ramenée aux champs que la détection attend. */
function offreDeFlux(item, i, merchant) {
  const name = String(item.title || "").trim();
  if (!name) return null;
  const url = item.link || item.guid || null;
  const prix =
    extrairePrix(item.price) ||
    extrairePrix(item.content || "") ||
    extrairePrix(item.contentSnippet || "") ||
    // Dernier recours : le prix dans le titre lui-même. Sans exigence de
    // monnaie, un titre « iPhone 15 128 Go » ferait n'importe quoi — la
    // prudence est dans extrairePrix, pas ici.
    extrairePrix(item.title) ||
    null;
  if (!Number.isFinite(prix)) return null;
  const img =
    (item.enclosure && item.enclosure.url) ||
    (item["media:content"] && item["media:content"].url) ||
    null;
  return {
    externalId: String(item.guid || item.link || `item-${i}`),
    name,
    price: prix,
    url,
    seller: merchant || null,
    img: img || null,
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
  const items = canal.item || canal.entry || [];
  if (!Array.isArray(items)) return [items].filter(Boolean);
  return items
    .map((item, i) => {
      const name = String(item.title || "").trim();
      if (!name) return null;
      const url = item.link || item["g:link"] || item.id || null;
      const prix = extrairePrix(item["g:price"] || item.price || item["s:price"]) || null;
      if (!Number.isFinite(prix)) return null;
      return {
        externalId: String(item.id || item.guid || item.link || `xml-${i}`),
        name,
        price: prix,
        url,
        seller: item["g:brand"] || null,
        img: item["g:image_link"] || null,
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
  return offres.map((o) => ({ ...o, seller: o.seller || cible.merchant || null }));
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
      const donnees = await appelFirecrawl("/scrape", {
        url: r.url,
        formats: ["markdown"],
        onlyMainContent: true,
      });
      const prix = prixDePage(donnees);
      if (!Number.isFinite(prix)) continue;
      const titre = (donnees.metadata?.title || r.title || cible.query).trim();
      offres.push({
        externalId: r.url,
        name: titre.slice(0, 200),
        price: prix,
        url: r.url,
        seller: cible.merchant || null,
      });
    } catch (e) {
      // Une page en échec ne doit pas faire échouer toute la cible : la
      // suivante peut très bien répondre.
      console.warn(`[collect] scrape échoué : ${r.url} — ${e.message}`);
    }
  }
  return offres;
}

/** Le canal de collecte d'une cible, selon ce qu'elle sait fournir. */
function collecterCible(cible) {
  if (cible.feedUrl) return collecterFlux(cible);
  if (cible.searchDomains && cible.searchDomains.length > 0) return collecterFirecrawl(cible);
  return Promise.reject(new Error("ni flux ni domaines de recherche"));
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
    return { runId: null, cibles: 0, offres: 0, analyses: 0, publies: 0, erreurs: 0, details: [] };
  }
  if (scanEnCours) {
    throw new Error("Un scan est déjà en cours.");
  }
  scanEnCours = true;

  const runId = debuterScan(source, cibles.length, userId);
  const bilan = { runId, cibles: cibles.length, offres: 0, analyses: 0, publies: 0, erreurs: 0, details: [] };

  try {
    for (const cible of cibles) {
      const ligne = { cible: cible.id, requete: cible.query, offres: 0, publies: 0, erreur: null };
      try {
        const offres = await collecterCible(cible);
        if (offres.length === 0) throw new Error("aucune offre exploitable");

        insertSnapshots(cible.query, cible.category, offres);

        // La détection elle-même : référence entre pairs du lot + historique
        // en base (voir algorithm.js). On ne publie que les anomalies.
        const analyses = analyzeOffers(offres).filter((o) => o.verdict !== "normal");
        let publies = 0;
        for (const a of analyses) {
          const id = upsertDeal({
            source: `d3-${cible.id}`,
            externalId: a.externalId,
            detector: "D3",
            type: a.verdict === "erreur" ? "erreur" : "promo",
            title: a.name,
            price: a.price,
            referencePrice: a.refPrice,
            url: a.url,
            imageUrl: a.img || null,
            merchant: a.seller || cible.merchant || null,
            category: cible.category,
            score: a.score,
            confidence: a.confidence,
            payload: {
              requete: cible.query,
              pct: a.pct,
              priceTotal: a.priceTotal,
              allTimeLow: Boolean(a.allTimeLow),
              zScore: a.zScore ?? null,
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
        bilan.analyses += analyses.length;
        bilan.publies += publies;
        ligne.offres = offres.length;
        ligne.publies = publies;
        logSourceEvent(cible.feedUrl ? "flux" : "firecrawl", true, `${offres.length} offre(s) — ${cible.query}`);
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
  updateTarget,
  deleteTarget,
  parseFluxRSS,
  parseFluxXML,
  extrairePrix,
  collecterFlux,
  collecterFirecrawl,
  collecterCible,
  lancerScan,
  etatCollecte,
};
