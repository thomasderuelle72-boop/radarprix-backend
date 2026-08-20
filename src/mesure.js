// mesure.js — Savoir si le moteur s'améliore, au lieu de l'espérer.
//
// Les barèmes du détecteur d'origine (+15 ici, −10 là, base 50) ne venaient
// d'aucune mesure. Rien ne disait au système s'il avait eu raison, et donc
// rien ne permettait de régler quoi que ce soit autrement qu'à l'intuition.
//
// Deux chiffres suffisent à piloter, et le produit fabrique déjà de quoi les
// calculer :
//
//  • La PRÉCISION — parmi ce qu'on publie, quelle part est fausse. Chaque
//    anomalie écartée par la modération est un faux positif confirmé, et ces
//    étiquettes s'accumulaient sans que personne ne les utilise.
//
//  • Le RAPPEL — parmi les vraies erreurs de prix qui existent, quelle part
//    on trouve. Impossible à connaître sans référence extérieure : on ne
//    peut pas mesurer ce qu'on ne voit pas. D'où l'ingestion, à usage
//    strictement interne, du flux public d'une communauté de bons plans
//    humaine, qui sert de vérité terrain.
//
// ⚠️ Ce flux est une référence de calibration, PAS une source de contenu :
// rien de ce qui est ingéré ici n'est republié. Republier le travail
// éditorial d'un tiers poserait un problème que la mesure ne pose pas.
const cheerio = require("cheerio");
const { db } = require("./db");
const { productKey, significantWords } = require("./productKey");
require("./dealsStore"); // garantit l'existence des tables deals et deal_feedback

const RSS_ERREURS_DE_PRIX = "https://www.dealabs.com/rss/groupe/erreur-de-prix";

db.exec(`
  -- Vérité terrain : erreurs de prix confirmées par une communauté humaine.
  -- Sert uniquement à mesurer le rappel. Aucune de ces lignes n'alimente le
  -- flux public.
  CREATE TABLE IF NOT EXISTS verite_terrain (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    product_key TEXT,
    merchant TEXT,
    price REAL,
    url TEXT,
    published_at TEXT,
    ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- Renseigné par rapprocher() : la détection RadarPrix correspondante,
    -- quand elle existe.
    matched_deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
    matched_at TEXT,
    UNIQUE(source, external_id)
  );
  CREATE INDEX IF NOT EXISTS idx_verite_key ON verite_terrain(product_key);
  CREATE INDEX IF NOT EXISTS idx_verite_pub ON verite_terrain(published_at);
`);

// deal_feedback — la matière première du calcul de précision — est créée par
// dealsStore : reputation.js la lit sans dépendre de ce module, et l'ordre
// des require() ne doit pas décider de l'existence d'une table.

/** Prix mentionné dans un titre de bon plan ("… à 199€", "199 euros"). */
function prixDuTitre(titre) {
  if (!titre) return null;
  const m = String(titre).match(/(\d[\d  ]*(?:[.,]\d{1,2})?)\s*(?:€|eur|euros?)/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/[\s ]/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Marchand mentionné dans un titre. Les titres communautaires suivent le plus
 * souvent la forme « Produit — Marchand » ou « Produit @Marchand ».
 * Approximatif par nature : sert au rapprochement, pas à l'affichage.
 */
function marchandDuTitre(titre) {
  if (!titre) return null;
  const m = String(titre).match(/(?:@|—|–|-|\bchez\b|\bsur\b)\s*([A-Za-zÀ-ÿ0-9.&' ]{2,30})\s*$/);
  return m ? m[1].trim() : null;
}

/** Transforme un flux RSS en entrées de vérité terrain. Fonction pure. */
function parseRssErreurs(xml, source = "dealabs") {
  const $ = cheerio.load(xml || "", { xmlMode: true });
  const entrees = [];

  $("item").each((_, el) => {
    const $el = $(el);
    const titre = $el.find("title").first().text().trim();
    const lien = $el.find("link").first().text().trim();
    if (!titre) return;

    const guid = $el.find("guid").first().text().trim() || lien || titre;
    const dateBrute = $el.find("pubDate").first().text().trim();
    const date = dateBrute ? new Date(dateBrute) : null;

    entrees.push({
      source,
      externalId: guid,
      title: titre,
      productKey: productKey(titre),
      merchant: marchandDuTitre(titre),
      price: prixDuTitre(titre),
      url: lien || null,
      publishedAt:
        date && !Number.isNaN(date.getTime())
          ? date.toISOString().slice(0, 19).replace("T", " ")
          : null,
    });
  });

  return entrees;
}

/** Écrit les entrées de vérité terrain, sans doublon. */
const enregistrerVerite = db.transaction((entrees) => {
  const stmt = db.prepare(
    `INSERT INTO verite_terrain (source, external_id, title, product_key, merchant, price, url, published_at)
     VALUES (@source, @externalId, @title, @productKey, @merchant, @price, @url, @publishedAt)
     ON CONFLICT(source, external_id) DO NOTHING`
  );
  let n = 0;
  for (const e of entrees) {
    stmt.run(e);
    n++;
  }
  return n;
});

/**
 * Récupère la vérité terrain. Échoue explicitement plutôt que silencieusement :
 * une mesure de rappel calculée sur une base vide donnerait 0 % et ferait
 * croire à une régression du moteur.
 */
async function ingererVeriteTerrain({ fetcher = fetch, url = RSS_ERREURS_DE_PRIX, source = "dealabs" } = {}) {
  const res = await fetcher(url, { headers: { Accept: "application/rss+xml, application/xml" } });
  if (!res.ok) throw new Error(`Flux de vérité terrain : HTTP ${res.status}`);
  const entrees = parseRssErreurs(await res.text(), source);
  const ecrits = enregistrerVerite(entrees);
  rapprocher();
  return { lues: entrees.length, ecrites: ecrits };
}

/**
 * Deux titres décrivent-ils probablement le même produit ?
 *
 * Volontairement plus permissif que sameProduct : ici on cherche à savoir si
 * on a détecté une erreur signalée par ailleurs, pas à établir une référence
 * de prix. Rater un rapprochement fait sous-estimer le rappel — ce qui est
 * moins grave que de le surestimer, mais reste une erreur de mesure.
 */
function memeProduitApproximatif(titreA, titreB) {
  const a = new Set(significantWords(titreA));
  const b = new Set(significantWords(titreB));
  if (a.size === 0 || b.size === 0) return false;
  let communs = 0;
  for (const m of a) if (b.has(m)) communs++;
  return communs / Math.min(a.size, b.size) >= 0.6;
}

/**
 * Rapproche la vérité terrain des détections RadarPrix.
 *
 * Fenêtre de trois jours autour de la publication communautaire : une erreur
 * de prix ne dure pas, et un rapprochement trop large compterait comme
 * « trouvée » une détection sans rapport.
 */
function rapprocher({ fenetreJours = 3 } = {}) {
  const aRapprocher = db
    .prepare("SELECT * FROM verite_terrain WHERE matched_deal_id IS NULL")
    .all();
  if (aRapprocher.length === 0) return 0;

  const maj = db.prepare(
    "UPDATE verite_terrain SET matched_deal_id = ?, matched_at = datetime('now') WHERE id = ?"
  );
  let n = 0;

  for (const v of aRapprocher) {
    const candidats = db
      .prepare(
        `SELECT id, title, merchant, price FROM deals
         WHERE detector IN ('D3','D4')
           AND first_seen_at BETWEEN datetime(?, ?) AND datetime(?, ?)`
      )
      .all(
        v.published_at || v.ingested_at,
        `-${fenetreJours} days`,
        v.published_at || v.ingested_at,
        `+${fenetreJours} days`
      );

    const trouve = candidats.find((c) => memeProduitApproximatif(c.title, v.title));
    if (trouve) {
      maj.run(trouve.id, v.id);
      n++;
    }
  }
  return n;
}

/** Enregistre le jugement d'un modérateur sur un deal publié. */
function noterDeal(dealId, verdict, { motif = null, userId = null } = {}) {
  if (!["faux_positif", "valide"].includes(verdict)) {
    throw new Error("Verdict attendu : 'faux_positif' ou 'valide'.");
  }
  db.prepare(
    `INSERT INTO deal_feedback (deal_id, verdict, motif, user_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(deal_id) DO UPDATE SET verdict = excluded.verdict, motif = excluded.motif, user_id = excluded.user_id`
  ).run(dealId, verdict, motif, userId);
}

/**
 * Les deux chiffres qui pilotent le réglage.
 *
 * Honnêteté de la mesure : la précision est calculée sur les seuls deals
 * qu'un modérateur a effectivement jugés. Comme on juge surtout ce qui
 * choque, cet échantillon n'est pas représentatif — le chiffre est donc un
 * indicateur de tendance, pas une précision au sens statistique. Le nombre
 * de deals jugés est renvoyé avec, précisément pour qu'on puisse s'en rendre
 * compte plutôt que de lire le pourcentage seul.
 */
function indicateurs({ jours = 30 } = {}) {
  const juges = db
    .prepare(
      `SELECT f.verdict, COUNT(*) AS n
       FROM deal_feedback f JOIN deals d ON d.id = f.deal_id
       WHERE f.created_at > datetime('now', ?)
       GROUP BY f.verdict`
    )
    .all(`-${jours} days`);

  const valides = juges.find((r) => r.verdict === "valide")?.n || 0;
  const faux = juges.find((r) => r.verdict === "faux_positif")?.n || 0;
  const totalJuges = valides + faux;

  const verite = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN matched_deal_id IS NOT NULL THEN 1 ELSE 0 END) AS trouvees
       FROM verite_terrain WHERE ingested_at > datetime('now', ?)`
    )
    .get(`-${jours} days`);

  const publies = db
    .prepare(
      `SELECT COUNT(*) AS n FROM deals
       WHERE published_at IS NOT NULL AND detector IN ('D3','D4')
         AND first_seen_at > datetime('now', ?)`
    )
    .get(`-${jours} days`).n;

  return {
    fenetreJours: jours,
    precision: {
      // null plutôt que 0 quand rien n'a été jugé : afficher « 0 % » ferait
      // croire à un moteur défaillant alors qu'on n'a simplement rien mesuré.
      taux: totalJuges > 0 ? Number((valides / totalJuges).toFixed(3)) : null,
      juges: totalJuges,
      fauxPositifs: faux,
      publies,
    },
    rappel: {
      taux: verite.total > 0 ? Number(((verite.trouvees || 0) / verite.total).toFixed(3)) : null,
      referencesConnues: verite.total,
      trouvees: verite.trouvees || 0,
    },
  };
}

/** Erreurs de prix connues que RadarPrix n'a pas vues — la liste à travailler. */
function manquees({ limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT title, merchant, price, url, published_at FROM verite_terrain
       WHERE matched_deal_id IS NULL
       ORDER BY published_at DESC LIMIT ?`
    )
    .all(limit);
}

module.exports = {
  RSS_ERREURS_DE_PRIX,
  parseRssErreurs,
  ingererVeriteTerrain,
  enregistrerVerite,
  rapprocher,
  noterDeal,
  indicateurs,
  manquees,
  prixDuTitre,
  marchandDuTitre,
  memeProduitApproximatif,
};
