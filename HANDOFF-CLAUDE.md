# Transfert Claude — Moteur de détection d'offres RadarPrix

Document à donner à Claude pour intégrer et déployer sur Railway le nouveau
moteur de détection (flux RSS/feeds marchands + scraping SaaS Firecrawl).

## Résumé de la mission

Remplacer l'ancienne machinerie de détection (retirée) par une acquisition
neuve, sans scrapers maison :

- **Cibles** (`watch_targets`) : un produit (`query`) + un canal —
  `feed_url` (RSS/Atom/XML Google Shopping, aucune clé) ou `search_domains`
  (JSON array de domaines, scraping Firecrawl).
- **Pipeline** (`lancerScan` dans `src/collect.js`) : collecte → `insertSnapshots`
  → `analyzeOffers` (algorithm.js existant) → publication des anomalies dans
  `deals` (détecteur `D3`, type `erreur`/`promo`) → suivi `scan_runs`/`source_events`.
- **CLI** : `npm run scan` (un scan synchrone, usage cron).
- **Routes admin** : `GET/POST/PATCH/DELETE /api/admin/targets`,
  `POST /api/admin/scan` (jeton admin ou en-tête `x-scan-token`),
  `GET /api/admin/scan/status`.
- **État public** : `radarEtat.js` lit désormais `watch_targets` + `scan_runs`.

Vérifié : 69 tests vitest OK, eslint OK, scan réel OK (33 offres, 1 anomalie
publiée : « Jeu de société - Love Letter » à 9,99 €, réf 25 €, −60 %).

## Fichiers créés (nouveaux)

| Fichier | Rôle |
|---|---|
| `src/collect.js` | Moteur d'acquisition : table `watch_targets`, CRUD, parsers RSS/XML, client Firecrawl, `lancerScan`, `etatCollecte` |
| `src/scan.js` | CLI de scan (`npm run scan`) |
| `src/env.js` | Charge `.env` puis `.env.local` (priorité à l'environnement réel) |
| `tests/collect.test.js` | Tests vitest (11) : parsers, CRUD, pipeline avec `fetch` simulé |
| `CLAUDE.md` | Contexte du dépôt pour Claude |

## Fichiers modifiés

| Fichier | Changement |
|---|---|
| `package.json` | + script `scan`, + `rss-parser@^3.13.0`, + `fast-xml-parser@^5.11.0` |
| `package-lock.json` | régénéré — lance `npm install` |
| `src/server.js` | + `require("./env")`, + `crypto`, + import `listScanRuns` et `collect`, + `autoriserScan`, + routes cibles/scan, + champ `detection` dans `/api/admin/health` |
| `src/radarEtat.js` | lit `watch_targets` (compte) et `scan_runs` (dernier balayage) |
| `README.md` | doc du moteur de détection + variables d'env |
| `.gitignore` | + `.env.local`, `.env.*.local` |

---

## Contenu des nouveaux fichiers

### src/collect.js

```js
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

/**
 * Extrait un prix d'une chaîne ("699,00 €", "EUR 499.99", "12,99 euros").
 *
 * Volontairement prudent : le prix doit être collé à un symbole ou mot
 * monétaire. Sans cette exigence, un titre « iPhone 15 128 Go » ferait
 * croire à un prix de 15 € ou 128 € — c'est le genre de faux signal qui
 * pollue toute la détection en aval. On accepte la monnaie avant comme
 * après le nombre, les deux conventions existant selon la source.
 */
function extrairePrix(texte) {
  if (!texte) return null;
  const propre = String(texte).replace(/\u00A0/g, " ");
  const m =
    propre.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:€|euros?|eur)/i) ||
    propre.match(/(?:€|euros?|eur)\s*(\d+(?:[.,]\d{1,2})?)/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
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
```

### src/scan.js

```js
// scan.js — Déclenche un scan complet depuis la ligne de commande ou le
// planificateur de l'hébergeur (Railway cron, cron-job.org…).
//
// Usage :
//   npm run scan                      # un scan de toutes les cibles actives
//   SCAN_SOURCE=manuel npm run scan   # étiqueter l'exécution autrement
//
// Le scan est synchrone : le processus ne se termine qu'une fois toutes les
// cibles traitées, ce qui permet au planificateur de savoir si cela a
// réussi (code de sortie 0) ou non (code de sortie 1).
require("./env");
const { lancerScan } = require("./collect");
const { fermerBase } = require("./db");

async function main() {
  const source = process.env.SCAN_SOURCE || "cron";
  let code = 0;
  try {
    const bilan = await lancerScan({ source });
    console.log(`[scan] ${bilan.cibles} cible(s) — ${bilan.offres} offre(s) collectée(s), ` +
      `${bilan.analyses} analyse(s), ${bilan.publies} publiée(s), ${bilan.erreurs} erreur(s).`);
    if (bilan.details.some((d) => d.erreur)) {
      for (const d of bilan.details.filter((x) => x.erreur)) {
        console.warn(`[scan] cible #${d.cible} (${d.requete}) : ${d.erreur}`);
      }
    }
    code = bilan.erreurs > 0 ? 1 : 0;
  } catch (e) {
    console.error(`[scan] échec : ${e.message}`);
    code = 1;
  } finally {
    try {
      fermerBase();
    } catch {
      // La base peut déjà être fermée : rien à faire de plus.
    }
  }
  // Le code de sortie n'est écrit qu'une fois, tout le travail terminé :
  // l'avertissement du linter sur les écritures atomiques ne s'applique pas.
  // eslint-disable-next-line require-atomic-updates
  process.exitCode = code;
}

main();
```

### src/env.js

```js
// env.js — Chargement des variables d'environnement locales.
//
// dotenv ne lit que `.env`. Or le sandbox Freebuff écrit ses secrets dans
// `.env.local` (via freebuff-env), et les deux fichiers coexistent. On
// charge donc les deux, dans cet ordre :
//
//   environnement réel (injecté par l'hébergeur)
//     > .env          (valeurs partagées du dépôt)
//     > .env.local    (secrets locaux, jamais commités)
//
// dotenv ne remplace jamais une variable déjà présente dans
// process.env : un secret injecté par l'hébergeur garde toujours la
// priorité, et un .env.local absent ne change rien.
require("dotenv").config();

const fs = require("fs");
const path = require("path");

const local = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(local)) {
  require("dotenv").config({ path: local });
}
```

### tests/collect.test.js

```js
// Tests du nouveau moteur d'acquisition : parsers de flux, cibles suivies
// et scan complet (collecte → snapshots → analyse → publication D3).
//
// Aucun appel réseau : fetch est simulé pour le flux comme pour Firecrawl,
// conformément à la règle de tests/setup.js (« aucun test ne part sur le
// réseau »).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const collect = require("../src/collect.js");
const { db, listScanRuns } = require("../src/db.js");
const { getDeal } = require("../src/dealsStore.js");

const FLUX_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Bonnes affaires</title>
    <item>
      <title>iPhone 15 128 Go</title>
      <link>https://magasin.fr/iphone-15-128</link>
      <guid>https://magasin.fr/iphone-15-128</guid>
      <price>999,00 €</price>
    </item>
    <item>
      <title>iPhone 15 128 Go</title>
      <link>https://magasin.fr/iphone-15-128-solde</link>
      <guid>https://magasin.fr/iphone-15-128-solde</guid>
      <price>349,00 €</price>
    </item>
  </channel>
</rss>`;

const FLUX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Catalogue</title>
    <item>
      <title>iPhone 15 128 Go</title>
      <link>https://magasin.fr/iphone-15-128</link>
      <g:price>899.00 EUR</g:price>
    </item>
    <item>
      <title>iPhone 15 128 Go</title>
      <link>https://magasin.fr/iphone-15-128-b</link>
      <g:price>399.00 EUR</g:price>
    </item>
  </channel>
</rss>`;

/** Réponse HTTP factice — le code ne lit que ok / text() / json(). */
function reponse({ ok = true, texte = null, json = null } = {}) {
  return { ok, text: async () => texte, json: async () => json };
}

beforeEach(() => {
  // Chaque test repart avec un jeu de cibles vierge : lancerScan balaie
  // toutes les cibles actives, celles du test précédent fausseraient le bilan.
  db.prepare("DELETE FROM watch_targets").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FIRECRAWL_API_KEY;
});

describe("extrairePrix", () => {
  it("lit les formats de prix français", () => {
    expect(collect.extrairePrix("699,00 €")).toBe(699);
    expect(collect.extrairePrix("Prix : 12,99 euros")).toBe(12.99);
    expect(collect.extrairePrix("EUR 499.99")).toBe(499.99);
    expect(collect.extrairePrix("19,90\u00A0€")).toBe(19.9);
  });

  it("refuse un nombre sans monnaie — un titre n'est pas un prix", () => {
    expect(collect.extrairePrix("iPhone 15 128 Go")).toBeNull();
    expect(collect.extrairePrix(null)).toBeNull();
    expect(collect.extrairePrix("")).toBeNull();
  });
});

describe("parsers de flux", () => {
  it("parse un flux RSS 2.0, avec le prix en balise dédiée ou dans le titre", async () => {
    const offres = await collect.parseFluxRSS(FLUX_RSS);
    expect(offres).toHaveLength(2);
    expect(offres[0]).toMatchObject({ name: "iPhone 15 128 Go", price: 999, seller: null });
    expect(offres[1].price).toBe(349);

    // Certains flux ne publient pas de balise prix : le prix vit dans le titre.
    const dansLeTitre = await collect.parseFluxRSS(
      `<rss version="2.0"><channel><item><title>Soldes iPhone 15 128 Go 449,00 €</title><link>https://x.fr/1</link></item></channel></rss>`
    );
    expect(dansLeTitre[0].price).toBe(449);
  });

  it("parse un feed marchand XML type Google Shopping (g:price)", async () => {
    const offres = collect.parseFluxXML(FLUX_XML);
    expect(offres).toHaveLength(2);
    expect(offres.map((o) => o.price)).toEqual([899, 399]);
    expect(offres[0].url).toBe("https://magasin.fr/iphone-15-128");
  });
});

describe("cibles suivies (watch_targets)", () => {
  it("exige un flux ou un domaine — une cible sans source est refusée", () => {
    expect(collect.addTarget({ query: "iPhone 15 128 Go" }).ok).toBe(false);
    expect(collect.addTarget({ query: "iPhone 15 128 Go", feedUrl: "https://magasin.fr/feed.xml" }).ok).toBe(true);
  });

  it("accepte un flux ou des domaines, et les restitue", () => {
    const r = collect.addTarget({
      query: "PS5 Slim",
      category: "gaming",
      merchant: "Magasin",
      domains: ["magasin.fr", "autre.fr"],
    });
    expect(r.ok).toBe(true);
    const cible = collect.getTarget(r.target.id);
    expect(cible.searchDomains).toEqual(["magasin.fr", "autre.fr"]);
    expect(cible.merchant).toBe("Magasin");
    expect(cible.category).toBe("gaming");
  });

  it("désactive sans supprimer, et supprime", () => {
    const { target } = collect.addTarget({ query: "Switch 2", feedUrl: "https://x.fr/feed.xml" });
    expect(collect.updateTarget(target.id, { active: false }).target.active).toBe(false);
    expect(collect.listTargets({ actives: true }).some((t) => t.id === target.id)).toBe(false);
    expect(collect.deleteTarget(target.id)).toBe(true);
    expect(collect.getTarget(target.id)).toBeNull();
  });
});

describe("scan complet", () => {
  it("sans aucune cible, le scan ne fait rien et ne plante pas", async () => {
    const bilan = await collect.lancerScan({});
    expect(bilan.cibles).toBe(0);
  });

  it("collecte, analyse et publie l'anomalie d'un flux (D3)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reponse({ texte: FLUX_RSS }))
    );
    collect.addTarget({
      query: "iPhone 15 128 Go",
      category: "high-tech",
      merchant: "Magasin",
      feedUrl: "https://magasin.fr/feed.xml",
    });

    const bilan = await collect.lancerScan({});
    expect(bilan.cibles).toBe(1);
    expect(bilan.offres).toBe(2);
    expect(bilan.publies).toBe(1);
    expect(bilan.erreurs).toBe(0);

    // Les deux offres sont archivées dans l'historique.
    const snapshots = db
      .prepare("SELECT COUNT(*) AS n FROM snapshots WHERE query = ?")
      .get("iPhone 15 128 Go");
    expect(snapshots.n).toBe(2);

    // L'anomalie est publiée dans le flux unifié, détecteur D3.
    const deal = db
      .prepare("SELECT id, detector, type, price, reference_price, published_at FROM deals WHERE detector = 'D3'")
      .get();
    expect(deal).not.toBeUndefined();
    expect(deal.type).toBe("promo");
    expect(deal.published_at).not.toBeNull();
    expect(getDeal(deal.id).discountPct).toBeGreaterThanOrEqual(40);

    // Le scan est refermé et la source « flux » consignée.
    const run = listScanRuns(1)[0];
    expect(run.ok_count).toBe(1);
    expect(run.fail_count).toBe(0);
    expect(run.finished_at).not.toBeNull();
    expect(collect.etatCollecte().find((s) => s.source === "flux").etat).toBe("ok");
  });

  it("passe par Firecrawl (recherche + scrape) quand la cible n'a pas de flux", async () => {
    process.env.FIRECRAWL_API_KEY = "cle-de-test";
    const fetchMock = vi.fn(async (url, options) => {
      if (url.includes("/search")) {
        return reponse({
          json: {
            success: true,
            data: [
              { url: "https://magasin.fr/p/1", title: "iPhone 15 128 Go" },
              { url: "https://magasin.fr/p/2", title: "iPhone 15 128 Go" },
            ],
          },
        });
      }
      // /scrape — la page cible est dans le corps de la requête, pas dans l'URL.
      const page = JSON.parse(options.body).url;
      const prix = page.includes("/p/2") ? 400 : 1000;
      return reponse({
        json: {
          success: true,
          data: {
            markdown: `# iPhone 15 128 Go\n\nPrix : ${prix},00 €`,
            metadata: { title: "iPhone 15 128 Go" },
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    collect.addTarget({
      query: "iPhone 15 128 Go",
      merchant: "Magasin",
      domains: ["magasin.fr"],
    });

    const bilan = await collect.lancerScan({});
    expect(bilan.offres).toBe(2);
    expect(bilan.publies).toBe(1);
    expect(bilan.erreurs).toBe(0);
    expect(fetchMock).toHaveBeenCalled();
    expect(collect.etatCollecte().find((s) => s.source === "firecrawl").etat).toBe("ok");
  });

  it("sans clé Firecrawl, la cible est comptée en échec sans appel réseau", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    collect.addTarget({ query: "Switch 2", domains: ["magasin.fr"] });
    const bilan = await collect.lancerScan({});

    expect(bilan.erreurs).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(collect.etatCollecte().find((s) => s.source === "firecrawl").etat).toBe("instable");
  });
});
```

### CLAUDE.md

```markdown
# RadarPrix — Contexte du dépôt (pour Claude)

## Vue d'ensemble

Backend Node.js / Express 5 d'un site français de bons plans (radarprix.fr).
Base **SQLite locale** (`better-sqlite3`), authentification **JWT + bcrypt**,
déployé sur Railway (le frontend, lui, est sur Vercel et n'est PAS dans ce
dépôt). L'API ne parle qu'en JSON.

Point d'entrée : `npm start` → `src/server.js` (port `PORT` ou 3001).

## Stack

- Node.js ≥ 18 (CommonJS côté serveur, ESM côté tests Vitest)
- express 5, helmet, cors, dotenv (via `src/env.js`)
- better-sqlite3 (synchrone, une seule connexion partagée `db` exportée par `src/db.js`)
- bcryptjs, jsonwebtoken
- rss-parser + fast-xml-parser (flux RSS/feeds marchands)
- Firecrawl (scraping SaaS, via REST `fetch`, pas de SDK)
- vitest + eslint (config dans `eslint.config.mjs`)

## Architecture (src/)

| Fichier | Rôle |
|---|---|
| `server.js` | Routeur Express : toutes les routes API, middlewares (helmet, CORS, rate limiting), arrêt propre SIGTERM |
| `db.js` (~2000 l.) | Connexion SQLite, schéma, migrations `ALTER TABLE`, fonctions d'accès (comptes, watchlist, modération, admin, suivi des scans `debuterScan`/`terminerScan`/`logSourceEvent`/`sourceHealth`, réglages `reglages()`/`definirReglage`, liste noire `offreBannie`) |
| `collect.js` | **Moteur d'acquisition neuf** : table `watch_targets`, CRUD, collecteurs (flux + Firecrawl), pipeline `lancerScan` |
| `scan.js` | CLI : `npm run scan` — un scan complet synchrone (usage cron) |
| `algorithm.js` | Analyse des prix : référence entre pairs + historique, verdicts `erreur`/`deal`, scores Deal/Confidence |
| `dealsStore.js` | Table unifiée `deals` (détecteurs D1–D4), ingestion idempotente `UNIQUE(source, external_id)`, flux public paginé |
| `productKey.js` | Normalisation de titres produits (clé d'identité pour l'historique) |
| `auth.js`, `moderation.js`, `messagerie.js`, `forum.js`, `notifications.js`, `badges.js`, `ranking.js`, `reputation.js`, `persistance.js`, `radarEtat.js`, `reinitialisation.js`, `env.js` | Comptes/sécurité, validation/anti-spam, salon + MP, forum, notifications, badges, score hot, fiabilité marchands, sauvegarde/restauration de la base, état public du radar, reset admin, chargement env |

## Moteur de détection (ce qui a été construit récemment)

L'ancienne machinerie (SerpApi, Bright Data, eBay, Awin, sitemaps, cron maison)
a été **retirée** puis **remplacée** par une acquisition propre :

- **Cibles** (`watch_targets`) : un produit (`query`), une catégorie, un
  marchand, et de quoi aller le chercher — **`feed_url`** (flux RSS/Atom ou
  XML type Google Shopping, aucune clé) **ou** **`search_domains`** (JSON
  array de domaines marchands pour Firecrawl).
- **Pipeline** (`lancerScan`) par cible : collecte → `insertSnapshots` →
  `analyzeOffers` (algorithm.js) → publication des anomalies dans `deals`
  (détecteur `D3`, type `erreur` ou `promo`) via `upsertDeal` + `publierDeal`.
  Pour les flux, `markMissingAsRemoved` retire les offres disparues.
- **Firecrawl** (REST, pas de SDK) :
  - `POST /v2/search` (réponse : `data.web[]` — ne PAS lire `data` directement)
  - `POST /v2/scrape` (`formats: ["markdown"]`) — prix pris dans
    `data.product.variants[].price.amount` si présent, sinon regex sur le
    markdown (heuristique, imparfaite).
  - Clé : `FIRECRAWL_API_KEY` (côté serveur uniquement).
- **Routes admin** (server.js) : `GET/POST/PATCH/DELETE /api/admin/targets`,
  `POST /api/admin/scan` (jeton admin **ou** en-tête `x-scan-token` si
  `SCAN_TOKEN` défini — comparaison en temps constant), `GET /api/admin/scan/status`.
- **État public** : `radarEtat.js` lit `watch_targets` + `scan_runs`
  (plus les anciennes tables de surveillance).
- Un seul scan à la fois (garde `scanEnCours`), échec d'une cible ≠ échec du
  scan (journalisé dans `source_events`, source `flux` ou `firecrawl`).

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `JWT_SECRET` | **Obligatoire.** Signe les sessions (30 j). |
| `DB_PATH` | Chemin SQLite. Prod : volume persistant. |
| `PORT` | Port d'écoute. |
| `ADMIN_EMAIL` | Email promu admin à l'inscription. |
| `CORS_ORIGINS` | Origines autorisées (remplace la liste par défaut). |
| `FIRECRAWL_API_KEY` | Clé du scraping SaaS (sans elle, seules les cibles à flux marchent). |
| `SCAN_TOKEN` | Jeton cron pour `POST /api/admin/scan` (en-tête `x-scan-token`). |

`src/env.js` charge `.env` puis `.env.local` (le sandbox Freebuff écrit ses
secrets dans `.env.local`, jamais commité — voir `.gitignore`). dotenv ne
remplace jamais une variable déjà présente dans l'environnement réel.

## Conventions

- **CommonJS** pour `src/` (require/module.exports), **ESM** pour `tests/`
  (import + `createRequire` pour charger les modules CJS).
- Commentaires **en français**, orientés « pourquoi » ; ne pas les supprimer.
- Chaque module de domaine crée ses **propres tables** (`dealsStore`,
  `notifications`, `collect`) avec `CREATE TABLE IF NOT EXISTS` sur la
  connexion partagée `db` — ne pas tout entasser dans `db.js`.
- Ingestion stricte : lever une erreur plutôt que stocker une ligne invalide.
- Sécurité : hachage bcrypt, propriété vérifiée dans les requêtes SQL,
  rate limiting en mémoire (par IP pour l'auth, par membre pour les
  publications), contrôle de suspension centralisé, clés API jamais côté client.
- `better-sqlite3` est synchrone : pas de `await` sur les requêtes DB.

## Tests

```bash
npm install
npm test        # vitest — 69 tests (tests/*.test.js, base SQLite temporaire isolée par fichier)
npm run lint    # eslint
npm run scan    # un scan complet de toutes les cibles actives (cron)
```

Les scripts legacy `test-*.js` à la racine ne font pas partie de `npm test`
(programmes à console.log conservés pour lecture).

## Limites connues / pistes

- Extraction du prix depuis le markdown Firecrawl = heuristique (regex) : peut
  attraper un mauvais nombre sur une page complexe. Fiabiliser en passant par
  `data.product` structuré de Firecrawl, ou par un LLM.
- `better-sqlite3` bloque le thread principal : plafond de charge du site.
- Rate limiting en mémoire : ok mono-processus (Railway), à revoir si scale-out.
- Pas de réinitialisation de mot de passe ni de vérification d'email.
- Les alertes watchlist (`watchersFor`, `recordAlertSent`, `email_log`) sont
  en place mais aucun envoi d'email n'est branché actuellement.
```

---

## Modifications des fichiers existants (diffs)

### package.json

```diff
   "scripts": {
     "start": "node src/server.js",
+    "scan": "node src/scan.js",
     "test": "vitest run",
     "test:watch": "vitest",
     "test:legacy": "node test-algorithm.js",
@@
     "cors": "^2.8.6",
     "dotenv": "^17.4.2",
     "express": "^5.2.1",
+    "fast-xml-parser": "^5.11.0",
     "helmet": "^8.3.0",
-    "jsonwebtoken": "^9.0.3"
+    "jsonwebtoken": "^9.0.3",
+    "rss-parser": "^3.13.0"
   },
```

> `package-lock.json` : régénère-le avec `npm install` (il doit contenir
> `rss-parser@^3.13.0` et `fast-xml-parser@^5.11.0` et leurs dépendances).

### .gitignore

```diff
 node_modules/
 .env
+.env.local
+.env.*.local
 data/
```

### src/radarEtat.js

```diff
-  if (existe("watched_urls")) {
-    const r = db
-      .prepare("SELECT COUNT(*) AS n, MAX(last_checked_at) AS dernier FROM watched_urls WHERE active = 1")
-      .get();
+  if (existe("watch_targets")) {
+    const r = db.prepare("SELECT COUNT(*) AS n FROM watch_targets WHERE active = 1").get();
     etat.fiches = r.n || 0;
-    etat.dernierBalayage = r.dernier || null;
+  }
+  if (existe("scan_runs")) {
+    const r = db.prepare("SELECT MAX(finished_at) AS d FROM scan_runs").get();
+    etat.dernierBalayage = r.d || null;
   }
```

(+ l'en-tête du fichier : ajouter le paragraphe expliquant que l'état vient
de `watch_targets` + `scan_runs`.)

### src/server.js

1. En-tête : `require("dotenv").config();` → `require("./env");` + ajouter
   `const crypto = require("crypto");`.
2. Dans le destructure `require("./db")` : ajouter `listScanRuns,` (avant `fermerBase,`).
3. Après les autres `require("./…")` : ajouter

```js
const {
  listTargets,
  getTarget,
  addTarget,
  updateTarget,
  deleteTarget,
  lancerScan,
  etatCollecte,
} = require("./collect");
```

4. Après `requireModerator` : ajouter

```js
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
```

5. Dans `GET /api/admin/health` : ajouter sous `persistance` :

```js
    detection: {
      cibles: listTargets({ actives: true }).length,
      dernierScan: listScanRuns(1)[0] || null,
    },
```

6. Après la route `GET /api/admin/users` : ajouter le bloc routes Détection

```js
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

// POST /api/admin/targets  { query, category?, merchant?, feedUrl?, domains? }
// Au moins un flux ou un domaine est requis : une cible sans source ne
// produirait que des échecs à chaque scan.
app.post("/api/admin/targets", requireAuth, requireAdmin, (req, res) => {
  const r = addTarget(req.body || {});
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json({ target: r.target });
});

// PATCH /api/admin/targets/:id  { active?, category?, merchant?, feedUrl?, domains? }
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
      console.log(`[scan] #${bilan.runId} : ${bilan.cibles} cible(s), ${bilan.offres} offre(s), ${bilan.publies} publiée(s), ${bilan.erreurs} erreur(s)`)
    )
    .catch((e) => console.error(`[scan] échec : ${e.message}`));
  res.status(202).json({
    demarre: true,
    message: "Scan lancé — suis son avancement sur GET /api/admin/scan/status.",
  });
});

// GET /api/admin/scan/status — exécutions récentes + santé des canaux de collecte.
app.get("/api/admin/scan/status", requireAuth, requireModerator, (req, res) => {
  res.json({ runs: listScanRuns(20), collecte: etatCollecte() });
});
```

### README.md

- Remplacer le bloc d'avertissement « La machinerie de détection a été
  retirée » par un bloc annonçant le nouveau moteur (acquisition flux +
  Firecrawl, analyse `algorithm.js`, publication D3).
- Tableau des domaines : ajouter 2 lignes (`collect.js`, `scan.js` en
  « Acquisition des offres » ; `algorithm.js`, `productKey.js` en
  « Analyse des prix »).
- Tableau des variables d'env : ajouter `FIRECRAWL_API_KEY` et `SCAN_TOKEN`.
- Ajouter une section « Détection » (cibles, canaux, déclenchement :
  `npm run scan`, routes admin) — cf. le diff complet dans le dépôt.

---

## Checklist déploiement Railway

1. **Appliquer les changements** : créer les 5 nouveaux fichiers, appliquer
   les diffs ci-dessus, puis `npm install` (met à jour `package-lock.json`).
2. **Vérifier** : `npm test` (69 tests) et `npm run lint`.
3. **Variables d'environnement Railway** :
   - `JWT_SECRET` (existant, obligatoire)
   - `DB_PATH=/app/data/radarprix.sqlite` (volume persistant, existant)
   - `ADMIN_EMAIL`, `CORS_ORIGINS` (existants)
   - **`FIRECRAWL_API_KEY`** = la clé Firecrawl (`fc-…`) — **nouveau, indispensable**
     pour les cibles à scraping ; les cibles à flux fonctionnent sans.
   - **`SCAN_TOKEN`** (optionnel) = jeton secret pour le cron.
4. **Déploiement** : Railway détecte `npm start` ; la base doit rester sur le
   volume persistant (les `data/` ne doivent PAS être commitées).
5. **Cron** (optionnel mais recommandé) : job Railway (ou cron-job.org)
   exécutant `npm run scan` toutes les X heures, **ou** appelant
   `POST /api/admin/scan` avec l'en-tête `x-scan-token: <SCAN_TOKEN>`.
6. **Après le premier déploiement**, créer les cibles (la base de prod est
   vierge — les cibles de test du sandbox ne partent pas avec le code) :

```bash
# Cible à flux (aucune clé requise)
curl -X POST https://api.radarprix.fr/api/admin/targets \
  -H "Authorization: Bearer <JETON_ADMIN>" -H "Content-Type: application/json" \
  -d '{"query": "Les bons plans du moment", "feedUrl": "https://www.dealabs.com/rss"}'

# Cible à scraping Firecrawl
curl -X POST https://api.radarprix.fr/api/admin/targets \
  -H "Authorization: Bearer <JETON_ADMIN>" -H "Content-Type: application/json" \
  -d '{"query": "iPhone 15 128 Go", "category": "high-tech", "merchant": "Cdiscount", "domains": ["cdiscount.com"]}'

# Lancer un scan
curl -X POST https://api.radarprix.fr/api/admin/scan \
  -H "Authorization: Bearer <JETON_ADMIN>"
```

7. **Vérifier** : `GET /api/admin/scan/status` (exécutions + santé des
   canaux), `GET /api/feed` (les anomalies publiées), `GET /api/radar`.
