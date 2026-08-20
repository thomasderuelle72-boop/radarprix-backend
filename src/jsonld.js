// jsonld.js — Lecture du prix directement sur la fiche du marchand.
//
// C'est la brique qui change l'économie du projet. Interroger une API de
// résultats de recherche coûte de l'ordre de 10 à 15 $ pour mille requêtes,
// ce qui impose de n'observer chaque produit qu'une fois toutes les seize
// heures. Or une erreur de prix vit une vingtaine de minutes : à cette
// cadence, la probabilité de la voir est d'environ 2 %.
//
// Lire la fiche marchande coûte une requête HTTP — de la bande passante, pas
// un abonnement. La même surveillance peut donc tourner toutes les quinze
// minutes, ce qui multiplie la probabilité de capture par plusieurs dizaines
// pour un coût inférieur.
//
// La plupart des marchands publient déjà leurs prix en données structurées
// schema.org, pour être compris de Google. Un seul analyseur fonctionne donc
// sur tous les sites qui les implémentent — contrairement à des sélecteurs
// CSS, qui cassent à chaque refonte et demandent un correctif par marchand.
const cheerio = require("cheerio");

/** Tous les blocs application/ld+json d'une page, analysés et aplatis. */
function extraireBlocsJsonLd(html) {
  const $ = cheerio.load(html || "");
  const blocs = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const brut = $(el).contents().text();
    if (!brut || !brut.trim()) return;
    try {
      blocs.push(JSON.parse(brut));
    } catch {
      // Un bloc mal formé est fréquent en production et ne doit jamais
      // empêcher de lire les autres blocs de la même page.
    }
  });

  return aplatir(blocs);
}

/**
 * Déplie les formes d'imbrication du standard : tableaux au premier niveau,
 * @graph, et nœuds imbriqués. Sans ça, une fiche produit publiée dans un
 * @graph — la forme que produisent WordPress et la plupart des CMS — reste
 * invisible.
 */
function aplatir(noeuds, profondeur = 0) {
  if (profondeur > 6) return []; // garde-fou contre une structure cyclique
  const sortie = [];
  for (const n of [].concat(noeuds)) {
    if (!n || typeof n !== "object") continue;
    sortie.push(n);
    if (Array.isArray(n["@graph"])) sortie.push(...aplatir(n["@graph"], profondeur + 1));
  }
  return sortie;
}

function estType(noeud, type) {
  const t = noeud?.["@type"];
  if (!t) return false;
  return [].concat(t).some((x) => String(x).toLowerCase().includes(type.toLowerCase()));
}

/** Prix exploitable, quel que soit le format publié ("1 299,00", "1299.00", 1299). */
function lirePrix(v) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  // Les séparateurs de milliers varient selon la locale du marchand. On
  // retire les espaces (y compris insécables), puis on tranche entre virgule
  // décimale et virgule de milliers d'après la position du dernier séparateur.
  // \u00a0 = espace insécable, \u202f = espace fine insécable : les deux
  // servent de séparateur de milliers en français ("1 299,00 €"). Elles
  // étaient écrites littéralement ici, donc invisibles à la relecture et
  // fragiles au moindre passage d'outil ; les échappements disent la même
  // chose sans dépendre de caractères qu'on ne voit pas.
  const nettoye = v.replace(/[\s\u00a0\u202f]/g, "").replace(/[^\d,.-]/g, "");
  const dernierePoint = nettoye.lastIndexOf(".");
  const derniereVirgule = nettoye.lastIndexOf(",");
  let normalise = nettoye;
  if (derniereVirgule > dernierePoint) {
    normalise = nettoye.replace(/\./g, "").replace(",", ".");
  } else if (dernierePoint > -1) {
    normalise = nettoye.replace(/,/g, "");
  }
  const n = parseFloat(normalise);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Disponibilité, ramenée à un booléen.
 * Une offre en rupture n'est pas une bonne affaire : c'est le premier motif
 * de déception d'un site de bons plans, et la raison d'être de cette
 * vérification avant publication.
 */
function lireDisponibilite(v) {
  if (v == null) return null;
  const t = String(v).toLowerCase();
  if (/outofstock|soldout|discontinued/.test(t)) return false;
  if (/instock|onlineonly|limitedavailability|presale|preorder|backorder/.test(t)) return true;
  return null;
}

/** Première offre exploitable trouvée dans un nœud Product. */
function offreDe(noeud) {
  const offres = [].concat(noeud.offers || []);
  for (const o of offres) {
    if (!o || typeof o !== "object") continue;
    // AggregateOffer expose lowPrice plutôt que price : c'est le prix le plus
    // bas parmi les vendeurs de la fiche, exactement ce qui nous intéresse.
    const prix = lirePrix(o.price ?? o.lowPrice ?? o.highPrice);
    if (prix == null) continue;
    return {
      prix,
      devise: o.priceCurrency || o.priceSpecification?.priceCurrency || null,
      enStock: lireDisponibilite(o.availability),
      vendeur: o.seller?.name || null,
      valideJusquA: o.priceValidUntil || null,
    };
  }
  return null;
}

/**
 * Lit le prix courant d'une fiche produit.
 *
 * @param {string} html
 * @returns {object|null} { price, currency, inStock, name, gtin, sku, seller, image }
 */
function extraireOffre(html) {
  for (const noeud of extraireBlocsJsonLd(html)) {
    if (!estType(noeud, "Product")) continue;
    const offre = offreDe(noeud);
    if (!offre) continue;

    return {
      price: offre.prix,
      currency: offre.devise,
      inStock: offre.enStock,
      name: typeof noeud.name === "string" ? noeud.name : null,
      // Le GTIN est l'identité exacte du produit : quand le marchand le
      // publie, il rend inutile toute heuristique de rapprochement par titre.
      gtin: noeud.gtin13 || noeud.gtin || noeud.gtin14 || noeud.gtin12 || noeud.gtin8 || null,
      sku: noeud.sku || noeud.mpn || null,
      seller: offre.vendeur,
      image: Array.isArray(noeud.image) ? noeud.image[0] : noeud.image || null,
      source: "jsonld",
    };
  }

  // Repli sur les balises meta Open Graph. Moins fiable — pas de stock, pas
  // de GTIN — mais suffisant pour suivre un prix chez les marchands qui ne
  // publient pas de données structurées complètes.
  return extraireOffreMeta(html);
}

function extraireOffreMeta(html) {
  const $ = cheerio.load(html || "");
  const meta = (...noms) => {
    for (const n of noms) {
      const v =
        $(`meta[property="${n}"]`).attr("content") || $(`meta[name="${n}"]`).attr("content");
      if (v) return v;
    }
    return null;
  };

  const prix = lirePrix(meta("product:price:amount", "og:price:amount", "twitter:data1"));
  if (prix == null) return null;

  return {
    price: prix,
    currency: meta("product:price:currency", "og:price:currency"),
    inStock: lireDisponibilite(meta("product:availability", "og:availability")),
    name: meta("og:title"),
    gtin: null,
    sku: null,
    seller: meta("og:site_name"),
    image: meta("og:image"),
    source: "meta",
  };
}

module.exports = {
  extraireOffre,
  extraireOffreMeta,
  extraireBlocsJsonLd,
  lirePrix,
  lireDisponibilite,
  aplatir,
  estType,
};
