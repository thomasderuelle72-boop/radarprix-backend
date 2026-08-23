// extraction.js — Lire une fiche produit telle que le marchand la publie.
//
// Presque tous les sites marchands français exposent déjà leurs fiches au
// format schema.org, en JSON-LD, pour être compris de Google. On y trouve
// exactement ce qu'une carte RadarPrix doit montrer : le nom, l'image, la
// description, les caractéristiques, le prix payé, le prix de référence, et
// jusqu'à la date de fin de l'offre.
//
// Lire cette source plutôt que d'attraper des nombres dans du texte change
// la nature du travail : on ne devine plus, on lit une déclaration faite
// par le marchand lui-même, dans un format spécifié. Les regex sur le
// markdown restent en dernier recours, pour les rares pages sans balisage.
//
// Trois niveaux, du plus fiable au moins fiable :
//
//   1. JSON-LD schema.org (Product / Offer / AggregateOffer)
//   2. Microdata schema.org (itemprop dans le HTML)
//   3. OpenGraph (og:*, product:*) — presque toujours présent, mais pauvre
//
// Aucun niveau n'invente : un champ absent reste absent.

/** Balises <script type="application/ld+json"> d'une page. */
const BLOCS_JSONLD = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Tous les objets JSON-LD d'une page, à plat.
 *
 * Le balisage réel est rarement simple : un tableau à la racine, un
 * `@graph`, des objets imbriqués. On aplatit tout plutôt que d'espérer une
 * forme précise, sinon la moitié des pages ne rendrait rien.
 */
function extraireJsonLd(html) {
  const objets = [];
  const empiler = (v) => {
    if (Array.isArray(v)) return v.forEach(empiler);
    if (!v || typeof v !== "object") return;
    objets.push(v);
    if (v["@graph"]) empiler(v["@graph"]);
  };

  for (const m of String(html || "").matchAll(BLOCS_JSONLD)) {
    try {
      // Certaines pages enveloppent le JSON dans un commentaire CDATA.
      empiler(JSON.parse(m[1].replace(/^\s*\/\*\s*<!\[CDATA\[\s*|\s*\]\]>\s*\*\/\s*$/g, "").trim()));
    } catch {
      // Un bloc mal formé ne doit pas faire perdre les autres blocs de la
      // page : on l'ignore et on continue.
    }
  }
  return objets;
}

/** `@type` peut être une chaîne ou un tableau ; la comparaison ignore la casse. */
function estType(objet, type) {
  const t = objet && objet["@type"];
  const liste = Array.isArray(t) ? t : [t];
  return liste.some((x) => String(x || "").toLowerCase() === type.toLowerCase());
}

/** Premier objet du balisage qui décrit un produit. */
function trouverProduit(objets) {
  return objets.find((o) => estType(o, "Product")) || null;
}

/**
 * Une valeur schema.org peut être un objet, un tableau, ou une chaîne.
 *
 * `name` passe avant `url` : une marque déclarée en objet Brand porte les
 * deux, et prendre l'adresse rendait « https://www.ldlc.com/ricoh/… » là où
 * la carte doit afficher « Ricoh ». Les images font l'inverse — leur valeur
 * utile est l'adresse — d'où le paramètre.
 */
function premiere(v, prefererUrl = false) {
  if (Array.isArray(v)) return premiere(v[0], prefererUrl);
  if (v && typeof v === "object") {
    return prefererUrl
      ? v.url || v.contentUrl || v.name || v["@id"] || v.value || null
      : v.name || v.value || v.url || v.contentUrl || v["@id"] || null;
  }
  return v ?? null;
}

/** Nombre décimal accepté sous ses écritures française et anglaise. */
function nombre(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  const brut = String(v).replace(/[\s\u00A0\u202F\u2009]/g, "").replace(",", ".");
  const n = parseFloat(brut.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Date ISO d'une valeur schema.org, ou null. */
function date(v) {
  const brut = premiere(v);
  if (!brut) return null;
  const d = new Date(String(brut));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Le prix de référence tel que le balisage le déclare.
 *
 * schema.org offre plusieurs emplacements selon les implémentations : un
 * `priceSpecification` de type ListPrice/StrikethroughPrice, le
 * `highPrice` d'une AggregateOffer, ou un `og:product:original_price`.
 * Aucune n'est majoritaire, donc on les lit toutes.
 */
function prixDeReference(offre, prixPaye) {
  const specs = [].concat(offre.priceSpecification || [], offre.priceSpecification?.priceSpecification || []);
  for (const spec of specs) {
    if (!spec || typeof spec !== "object") continue;
    const type = String(spec.priceType || spec["@type"] || "").toLowerCase();
    const valeur = nombre(spec.price ?? spec.value);
    if (!Number.isFinite(valeur)) continue;
    if (/list|strikethrough|regular|msrp|suggested/.test(type) && valeur > prixPaye) return valeur;
  }
  const haut = nombre(offre.highPrice);
  if (Number.isFinite(haut) && haut > prixPaye) return haut;
  return null;
}

/** L'offre exploitable d'un produit : une Offer, ou la meilleure d'une AggregateOffer. */
function trouverOffre(produit) {
  const offres = [].concat(produit.offers || []);
  for (const o of offres) {
    if (!o || typeof o !== "object") continue;
    if (estType(o, "AggregateOffer")) {
      const bas = nombre(o.lowPrice ?? o.price);
      if (Number.isFinite(bas)) return { ...o, price: bas };
      continue;
    }
    if (Number.isFinite(nombre(o.price))) return o;
  }
  return null;
}

/**
 * Caractéristiques déclarées : `additionalProperty` est la façon
 * schema.org de dire « capacité : 512 Go », « couleur : noir ». C'est ce
 * qui distingue une fiche produit d'une ligne de prix.
 */
function caracteristiques(produit) {
  const sortie = [];
  for (const p of [].concat(produit.additionalProperty || [])) {
    if (!p || typeof p !== "object") continue;
    const nom = premiere(p.name);
    const valeur = premiere(p.value);
    if (nom && valeur != null) sortie.push({ nom: String(nom), valeur: String(valeur) });
  }
  // Quelques attributs de premier plan vivent hors additionalProperty.
  for (const [cle, libelle] of [["color", "Couleur"], ["material", "Matière"], ["size", "Taille"], ["model", "Modèle"]]) {
    const v = premiere(produit[cle]);
    if (v) sortie.push({ nom: libelle, valeur: String(v) });
  }
  return sortie;
}

/** État de l'article d'après itemCondition (vocabulaire schema.org). */
function etat(offre, produit) {
  const brut = String(premiere(offre?.itemCondition, true) || premiere(produit?.itemCondition, true) || "").toLowerCase();
  if (/refurbished/.test(brut)) return "reconditionne";
  if (/used|damaged/.test(brut)) return "occasion";
  return "neuf";
}

/* ── Repli OpenGraph ──────────────────────────────────────────────
   Bien plus pauvre que schema.org, mais présent sur des pages qui n'ont
   aucun balisage produit — et il porte au moins l'image et le prix. */
function baliseMeta(html, propriete) {
  const motif = new RegExp(
    `<meta[^>]+(?:property|name)=["']${propriete.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]+content=["']([^"']*)["']`,
    "i"
  );
  const inverse = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${propriete.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
    "i"
  );
  const m = String(html || "").match(motif) || String(html || "").match(inverse);
  return m ? m[1] : null;
}

function produitDepuisOpenGraph(html) {
  const prix = nombre(baliseMeta(html, "product:price:amount") || baliseMeta(html, "og:price:amount"));
  if (!Number.isFinite(prix)) return null;
  const ref = nombre(baliseMeta(html, "product:original_price:amount"));
  return {
    nom: baliseMeta(html, "og:title"),
    description: baliseMeta(html, "og:description"),
    image: baliseMeta(html, "og:image"),
    marque: baliseMeta(html, "product:brand"),
    prix,
    prixReference: Number.isFinite(ref) && ref > prix ? ref : null,
    devise: baliseMeta(html, "product:price:currency") || "EUR",
    disponible: null,
    finOffre: null,
    caracteristiques: [],
    etat: "neuf",
    sku: null,
    source: "opengraph",
  };
}

/* ── Repli microdata ──────────────────────────────────────────────
   Le même vocabulaire schema.org, mais porté par des attributs itemprop
   au lieu d'un bloc JSON. Encore répandu sur les sites plus anciens. */
function itemprop(html, nom) {
  const texte = String(html || "");
  // La valeur d'un itemprop ne vit pas toujours dans `content` : une image
  // la porte dans `src`, un lien dans `href`, un libellé dans le texte de
  // la balise. Ne lire que `content` faisait perdre précisément l'image et
  // la disponibilité — deux champs qu'une carte affiche.
  const attribut = "(?:content|src|href)";
  const apresProp = new RegExp(`itemprop=["']${nom}["'][^>]*${attribut}=["']([^"']*)["']`, "i");
  const avantProp = new RegExp(`${attribut}=["']([^"']*)["'][^>]*itemprop=["']${nom}["']`, "i");
  const enTexte = new RegExp(`itemprop=["']${nom}["'][^>]*>([^<]{1,200})<`, "i");
  const m = texte.match(apresProp) || texte.match(avantProp) || texte.match(enTexte);
  return m ? m[1].trim() : null;
}

function produitDepuisMicrodata(html) {
  const prix = nombre(itemprop(html, "price"));
  if (!Number.isFinite(prix)) return null;
  return {
    nom: itemprop(html, "name"),
    description: itemprop(html, "description"),
    image: itemprop(html, "image"),
    marque: itemprop(html, "brand"),
    prix,
    prixReference: null,
    devise: itemprop(html, "priceCurrency") || "EUR",
    disponible: /InStock/i.test(itemprop(html, "availability") || "") || null,
    finOffre: itemprop(html, "priceValidUntil"),
    caracteristiques: [],
    etat: "neuf",
    sku: itemprop(html, "sku"),
    source: "microdata",
  };
}

/** Normalise un objet Product du balisage, ou null s'il n'a pas de prix. */
function ficheDepuisProduit(produit) {
  const offre = trouverOffre(produit);
  const prix = offre ? nombre(offre.price) : null;
  if (!Number.isFinite(prix)) return null;

  const dispo = String(premiere(offre.availability, true) || "");
  return {
    nom: premiere(produit.name),
    description: premiere(produit.description),
    image: premiere(produit.image, true),
    marque: premiere(produit.brand),
    url: premiere(offre.url, true) || premiere(produit.url, true) || null,
    prix,
    prixReference: prixDeReference(offre, prix),
    devise: premiere(offre.priceCurrency) || "EUR",
    disponible: dispo ? /InStock|LimitedAvailability|PreOrder/i.test(dispo) : null,
    // Deux noms pour la même idée selon les implémentations.
    finOffre: date(offre.priceValidUntil) || date(offre.validThrough),
    debutOffre: date(offre.validFrom),
    caracteristiques: caracteristiques(produit),
    etat: etat(offre, produit),
    sku: premiere(produit.sku) || premiere(produit.gtin13) || premiere(produit.mpn) || null,
    source: "jsonld",
  };
}

/**
 * TOUTES les fiches produits d'une page, pas seulement la première.
 *
 * C'est ce qui rend une page « promotions » exploitable : une seule
 * requête rapporte les vingt ou cinquante articles qu'elle liste, là où
 * visiter chaque fiche une par une coûterait autant d'appels que
 * d'articles. À cent enseignes, la différence décide si le site est
 * tenable ou non.
 *
 * Les listes schema.org (`ItemList`) sont parcourues aussi : beaucoup de
 * pages de rayon n'exposent leurs produits que là.
 */
function produitsDepuisHtml(html) {
  const objets = extraireJsonLd(html);
  const produits = [];

  const ajouter = (o) => {
    if (!o || typeof o !== "object") return;
    if (estType(o, "Product")) produits.push(o);
    // Un ItemList porte ses éléments dans itemListElement, chacun étant
    // soit le produit lui-même, soit un ListItem qui l'enveloppe.
    for (const el of [].concat(o.itemListElement || [])) {
      if (!el || typeof el !== "object") continue;
      if (estType(el, "Product")) produits.push(el);
      else if (el.item && typeof el.item === "object") ajouter(el.item);
    }
  };
  objets.forEach(ajouter);

  const vues = new Set();
  const fiches = [];
  for (const p of produits) {
    const f = ficheDepuisProduit(p);
    if (!f || !f.nom) continue;
    // Une même fiche peut apparaître dans un ItemList ET à la racine.
    const cle = f.sku || f.url || `${f.nom}|${f.prix}`;
    if (vues.has(cle)) continue;
    vues.add(cle);
    fiches.push(f);
  }
  return fiches;
}

/**
 * Fiche produit normalisée à partir du HTML d'une page marchande.
 *
 * Renvoie null si la page ne déclare aucun prix : mieux vaut ne rien
 * publier qu'une carte creuse. `source` dit d'où vient l'information, ce
 * qui permet de mesurer la qualité du balisage marchand par marchand.
 */
function produitDepuisHtml(html) {
  const produit = trouverProduit(extraireJsonLd(html));
  const offre = produit ? trouverOffre(produit) : null;
  const prix = offre ? nombre(offre.price) : null;

  if (produit && Number.isFinite(prix)) {
    const dispo = String(premiere(offre.availability, true) || "");
    return {
      nom: premiere(produit.name),
      description: premiere(produit.description),
      image: premiere(produit.image, true),
      marque: premiere(produit.brand),
      prix,
      prixReference: prixDeReference(offre, prix),
      devise: premiere(offre.priceCurrency) || "EUR",
      disponible: dispo ? /InStock|LimitedAvailability|PreOrder/i.test(dispo) : null,
      // Deux noms pour la même idée selon les implémentations.
      finOffre: date(offre.priceValidUntil) || date(offre.validThrough),
      debutOffre: date(offre.validFrom),
      caracteristiques: caracteristiques(produit),
      etat: etat(offre, produit),
      sku: premiere(produit.sku) || premiere(produit.gtin13) || premiere(produit.mpn) || null,
      source: "jsonld",
    };
  }

  return produitDepuisMicrodata(html) || produitDepuisOpenGraph(html);
}

module.exports = {
  extraireJsonLd,
  produitsDepuisHtml,
  produitDepuisHtml,
  produitDepuisOpenGraph,
  produitDepuisMicrodata,
};
