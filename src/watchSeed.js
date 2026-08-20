// watchSeed.js — Remplir la liste des fiches surveillées sans rien inventer.
//
// Le moteur d'erreur de prix (watch.js) est complet mais tourne à vide : il
// ne surveille que ce qu'on lui donne, et personne ne lui a rien donné. Le
// réflexe serait d'écrire une liste d'adresses de fiches produits à la main.
// Mauvaise idée : une URL de fiche change au moindre remaniement de site, et
// une liste écrite sans pouvoir la vérifier remplirait le tableau de bord
// d'échecs de lecture — donnant l'impression d'un moteur cassé alors que ce
// seraient les adresses qui seraient fausses.
//
// La base contient déjà mieux que ça. Chaque scan passé a enregistré, dans
// `snapshots`, l'adresse réelle de chaque offre chez son marchand. Ce sont
// des fiches qui ont existé, qui ont servi une fois, et qui portent déjà le
// nom du produit et celui du vendeur.
//
// On les promeut donc en fiches surveillées, plutôt que d'en inventer.
const { db } = require("./db");
const { ajouterUrl, domaineDe } = require("./watch");
const { marchandRetenu } = require("./curation");

// Une adresse d'agrégateur n'est pas une fiche marchande : la relire ne dit
// rien du prix pratiqué par le vendeur, et Google refuse d'être interrogé de
// cette façon. On ne garde que les liens qui pointent chez le marchand.
const DOMAINES_EXCLUS = [
  "google.", "googleadservices.", "googleusercontent.",
  "shopping.google", "bing.", "awin1.com", "awin.com",
];

function estFicheMarchande(url) {
  const domaine = domaineDe(url);
  if (!domaine) return false;
  return !DOMAINES_EXCLUS.some((exclu) => domaine.includes(exclu));
}

/**
 * Promeut en fiches surveillées les adresses marchandes déjà observées.
 *
 * @param {object} [opts]
 * @param {number} [opts.limite]        nombre maximum de fiches à ajouter
 * @param {boolean} [opts.toutMarchand] ignorer le filtre d'enseignes retenues
 * @returns {{candidats: number, ajoutees: number, ignorees: number, parMarchand: object}}
 */
function amorcerDepuisSnapshots({ limite = 40, toutMarchand = false } = {}) {
  // Une fiche par couple produit/vendeur, la plus récemment vue. Surveiller
  // deux adresses du même produit chez le même marchand ne rapporterait
  // aucune information supplémentaire et doublerait les requêtes.
  const candidats = db
    .prepare(
      `SELECT s.url, s.name, s.seller, s.category, MAX(s.scraped_at) AS vu
       FROM snapshots s
       WHERE s.url IS NOT NULL AND s.url != ''
         AND s.url NOT IN (SELECT url FROM watched_urls)
       GROUP BY s.product_key, s.seller
       ORDER BY vu DESC`
    )
    .all();

  let ajoutees = 0;
  let ignorees = 0;
  const parMarchand = {};

  for (const c of candidats) {
    if (ajoutees >= limite) break;
    if (!estFicheMarchande(c.url)) {
      ignorees++;
      continue;
    }
    // Même exigence que pour les promotions : surveiller un marchand que
    // personne ne connaît produirait des détections que personne ne suivra.
    if (!toutMarchand && !marchandRetenu(c.seller)) {
      ignorees++;
      continue;
    }
    try {
      ajouterUrl({
        url: c.url,
        label: c.name,
        merchant: c.seller,
        category: c.category || "tout",
        produit: c.name,
      });
      ajoutees++;
      parMarchand[c.seller] = (parMarchand[c.seller] || 0) + 1;
    } catch {
      // URL malformée : on passe. C'est exactement ce que le filtrage
      // manuel n'aurait pas su faire de façon fiable.
      ignorees++;
    }
  }

  return { candidats: candidats.length, ajoutees, ignorees, parMarchand };
}

module.exports = { amorcerDepuisSnapshots, estFicheMarchande, DOMAINES_EXCLUS };
