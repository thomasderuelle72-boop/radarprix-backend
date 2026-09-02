// marche.js — L'analyse par PRODUIT, une fois le scan terminé.
//
// LE MANQUE QU'IL COMBLE
//
// `lancerScan` appelle `analyzeOffers` **par cible**. Or une cible catalogue,
// c'est soixante fiches d'un seul marchand, toutes des produits différents :
// `grouperOffres` rend soixante groupes de un, `comparables.length` reste
// sous `minPairs`, et la référence entre pairs ne peut PAS exister. Sur le
// seul canal dont les anomalies sont les nôtres, la détection reposait donc
// à cent pour cent sur le passé de la même enseigne — d'où `baseReference:
// "marchand"` sur 31 des 51 offres mesurées le 2 septembre 2026.
//
// Les marchands ne se rencontraient jamais dans un même lot. Ce module les
// fait se rencontrer : il ne collecte rien, il RELIT ce qui a été collecté,
// groupé cette fois par identité produit et non par cible.
//
// C'est le découplage qui rend le système extensible : ajouter une source ne
// change rien ici, et changer la façon de juger ne change rien aux sources.
// L'acquisition écrit des observations ; l'analyse les lit.
const { db, reglages } = require("./db");
const { analyzeOffers } = require("./algorithm");
const produits = require("./produits");

/* Fenêtre de comparaison. Un prix relevé il y a trois jours chez un marchand
   et un prix d'aujourd'hui chez un autre restent comparables — la rotation
   des catalogues repasse sur chaque fiche toutes les quarante heures, exiger
   la simultanéité ne comparerait jamais rien. Au-delà, en revanche, on
   compare un marché avec son souvenir. */
const FENETRE_HEURES = 96;

/* Un plafond, parce que ce module tourne dans le processus qui sert le site
   et que better-sqlite3 bloque le thread principal. Cinq cents produits
   comparés, c'est quelques dizaines de millisecondes ; tout le catalogue,
   c'est une page blanche pour les visiteurs. */
const PRODUITS_PAR_PASSE = 500;

/**
 * Le dernier prix connu de chaque marchand, pour chaque produit vu chez au
 * moins `minMarchands` enseignes dans la fenêtre.
 *
 * Le `MAX(scraped_at)` par (produit, marchand) est la seule façon honnête de
 * comparer : prendre tous les relevés donnerait le poids du plus bavard.
 */
function relevesComparables({ heures = FENETRE_HEURES, minMarchands = 2, limite = PRODUITS_PAR_PASSE } = {}) {
  const depuis = `-${heures} hours`;

  const eligibles = db
    .prepare(
      `SELECT produit_id, COUNT(DISTINCT seller) AS marchands
         FROM snapshots
        WHERE produit_id IS NOT NULL AND price > 0 AND seller IS NOT NULL
          AND scraped_at > datetime('now', ?)
        GROUP BY produit_id
       HAVING marchands >= ?
        ORDER BY marchands DESC, produit_id DESC
        LIMIT ?`
    )
    .all(depuis, minMarchands, limite);

  if (eligibles.length === 0) return [];
  const ids = eligibles.map((e) => e.produit_id);

  /* Une seule requête pour tout le lot. Une par produit ferait cinq cents
     allers-retours SQLite sur le thread qui répond aux visiteurs. */
  const lignes = db
    .prepare(
      `SELECT s.produit_id, s.seller, s.price, s.delivery, s.name, s.url, s.img,
              s.item_condition, s.scraped_at
         FROM snapshots s
         JOIN (
           SELECT produit_id, seller, MAX(scraped_at) AS dernier
             FROM snapshots
            WHERE produit_id IN (${ids.map(() => "?").join(",")})
              AND price > 0 AND seller IS NOT NULL
              AND scraped_at > datetime('now', ?)
            GROUP BY produit_id, seller
         ) d
           ON d.produit_id = s.produit_id AND d.seller = s.seller AND d.dernier = s.scraped_at
        WHERE s.price > 0`
    )
    .all(...ids, depuis);

  const parProduit = new Map(ids.map((i) => [i, []]));
  for (const l of lignes) {
    const lot = parProduit.get(l.produit_id);
    // Le JOIN sur MAX peut rendre deux lignes si deux relevés partagent la
    // seconde exacte. Un marchand ne compte qu'une fois.
    if (lot && !lot.some((o) => o.seller === l.seller)) {
      lot.push({
        produitId: l.produit_id,
        name: l.name,
        price: l.price,
        delivery: l.delivery,
        seller: l.seller,
        url: l.url,
        img: l.img,
        itemCondition: l.item_condition || "neuf",
        scrapedAt: l.scraped_at,
      });
    }
  }

  return [...parProduit.entries()]
    .map(([produitId, offres]) => ({ produitId, offres }))
    .filter((p) => new Set(p.offres.map((o) => o.seller)).size >= minMarchands);
}

/**
 * Analyse le marché produit par produit et rend les anomalies trouvées.
 *
 * Ne publie rien : rendre le résultat plutôt que l'écrire laisse l'appelant
 * décider, et rend la fonction testable sans base de deals. C'est la même
 * séparation qu'entre acquisition et analyse, un cran plus bas.
 */
function analyserMarche(options = {}) {
  const R = reglages();
  const lots = relevesComparables(options);
  const anomalies = [];
  let comparés = 0;

  for (const { produitId, offres } of lots) {
    comparés += 1;
    /* `analyzeOffers` sait déjà tout faire : médiane rognée, retrait des
       aberrants, pondération par l'historique, deux scores. Ce qui lui
       manquait n'était pas de l'intelligence, c'était un lot où plusieurs
       marchands se trouvent en même temps. On le lui donne enfin. */
    const analyses = analyzeOffers(offres);
    for (const a of analyses) {
      if (a.verdict === "normal") continue;
      // Une anomalie de marché n'a de sens que si elle vient bien du marché.
      if (a.marchandsComparés < 2) continue;
      anomalies.push({ ...a, produitId, produit: produits.produit(produitId) });
    }
  }

  return {
    produitsComparés: comparés,
    anomalies: anomalies.sort((a, b) => b.pct - a.pct),
    seuilErreur: R.seuilErreur,
    seuilDeal: R.seuilDeal,
  };
}

/** De quoi juger la couverture du rapprochement, sans ouvrir la base à la main. */
function etatDuMarche({ heures = FENETRE_HEURES } = {}) {
  const depuis = `-${heures} hours`;
  const g = db
    .prepare(
      `SELECT COUNT(*) AS releves,
              COUNT(DISTINCT produit_id) AS produits,
              SUM(ean IS NOT NULL) AS releves_avec_ean
         FROM snapshots
        WHERE scraped_at > datetime('now', ?)`
    )
    .get(depuis);
  const partages = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT produit_id FROM snapshots
          WHERE produit_id IS NOT NULL AND price > 0 AND seller IS NOT NULL
            AND scraped_at > datetime('now', ?)
          GROUP BY produit_id HAVING COUNT(DISTINCT seller) >= 2)`
    )
    .get(depuis).n;
  return { fenetreHeures: heures, ...g, produitsMultiMarchands: partages, couverture: produits.couverture() };
}

module.exports = { analyserMarche, relevesComparables, etatDuMarche, FENETRE_HEURES, PRODUITS_PAR_PASSE };
