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

/**
 * Un nombre est-il un prix ?
 *
 * `Number.isFinite` répond « oui » à ZÉRO, et c'est ce détail qui a mis le
 * site en défaut le 2 septembre 2026 : les cinquante et une offres publiées
 * étaient toutes à 0,00 €, toutes verdict « erreur », toutes à −100 %. Une
 * pelote de laine annoncée gratuite à la place de 5 €, un combo guitare à la
 * place de 777 €. L'algorithme n'avait rien fait de faux — on lui avait donné
 * un prix nul et il en a conclu, correctement, une remise de cent pour cent.
 *
 * Un marchand écrit `"price": "0"` sur une fiche épuisée, en rupture, ou
 * réservée à un vendeur tiers absent. Ce n'est pas un prix : c'est l'absence
 * de prix, écrite avec un chiffre. La borne haute écarte de même les lectures
 * fautives (un code EAN pris pour un montant) : aucun article de détail
 * français ne se vend dix millions d'euros.
 */
const PRIX_MAX = 1e7;

function prixValide(n) {
  return Number.isFinite(n) && n > 0 && n < PRIX_MAX;
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
      /* Une AggregateOffer dont aucun vendeur ne propose l'article annonce
         `lowPrice: 0`. Le lire comme un prix, c'est publier « gratuit ». */
      const bas = nombre(o.lowPrice ?? o.price);
      if (prixValide(bas)) return { ...o, price: bas };
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
/* Les balises meta transportent des entités : « R&#xE9;frig&#xE9;rateur »
   s'affiche tel quel si on ne les décode pas. */
function decoderEntites(v) {
  return String(v || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|rsquo|#39);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
}

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
  return m ? decoderEntites(m[1]) || null : null;
}

function produitDepuisOpenGraph(html) {
  const prix = nombre(baliseMeta(html, "product:price:amount") || baliseMeta(html, "og:price:amount"));
  if (!prixValide(prix)) return null;
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
/**
 * Réduit le HTML à la portée de l'élément Product.
 *
 * Sans ce cadrage, `itemprop="name"` attrapait le PREMIER de la page — et
 * sur beaucoup de sites c'est le fil d'Ariane. Toutes les fiches d'Electro
 * Dépôt sont ainsi ressorties sous le nom « Accueil » : l'algorithme les a
 * prises pour un même produit, en a tiré un prix de référence commun, et le
 * site a publié vingt-cinq fausses erreurs de prix à −80 %.
 *
 * On part du marqueur Product et on garde ce qui suit : imparfait faute
 * d'analyseur HTML, mais il place le fil d'Ariane hors champ, ce qui est
 * tout ce qu'on lui demande.
 */
function portéeProduit(html) {
  const texte = String(html || "");
  const m = texte.match(/itemtype=["'][^"']*schema\.org\/Product["']/i);
  return m ? texte.slice(m.index) : null;
}

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

function produitDepuisMicrodata(htmlComplet) {
  // Pas de marqueur Product : la page n'a pas de microdata produit, et lire
  // ses itemprop reviendrait à lire le fil d'Ariane ou le pied de page.
  const html = portéeProduit(htmlComplet);
  if (!html) return null;

  const prix = nombre(itemprop(html, "price"));
  if (!prixValide(prix)) return null;
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
  if (!prixValide(prix)) return null;

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

/* Libellés de navigation qu'un balisage mal cadré fait passer pour un nom
   de produit. Vu en production : toutes les fiches d'Electro Dépôt sont
   ressorties sous le nom « Accueil », premier maillon de leur fil
   d'Ariane. L'algorithme les a prises pour un même produit, en a tiré un
   prix de référence commun, et le site a publié vingt-cinq fausses erreurs
   de prix à −80 %. */
const NOMS_DE_NAVIGATION = /^(accueil|home|boutique|shop|produits?|products?|catalogue|catalog|menu|panier|recherche|search|catégories?|categories?)$/i;

/** Titre de la page, dernier recours quand le balisage ne nomme rien. */
function titrePage(html) {
  const m = String(html || "").match(/<title[^>]*>([^<]{3,200})<\/title>/i);
  if (!m) return null;
  // « Nom du produit - Enseigne » : on garde ce qui précède le séparateur.
  return decoderEntites(m[1]).split(/\s+[|–—]\s+|\s+-\s+(?=[A-ZÉÀ][a-zé]+\s*$)/)[0].trim() || null;
}

/**
 * Corrige un nom que le balisage a mal rendu.
 *
 * Un libellé de navigation ne nomme aucun produit. Plutôt que de publier
 * vingt fiches appelées « Accueil » — qui se retrouveraient groupées comme
 * un même article — on reprend le titre de la page, qui le nomme presque
 * toujours correctement.
 */
function nomFiable(nom, html) {
  const propre = String(nom || "").trim();
  if (propre && !NOMS_DE_NAVIGATION.test(propre)) return propre;
  return baliseMeta(html, "og:title") || titrePage(html) || null;
}

/**
 * Fiche produit normalisée à partir du HTML d'une page marchande.
 *
 * Renvoie null si la page ne déclare aucun prix : mieux vaut ne rien
 * publier qu'une carte creuse. `source` dit d'où vient l'information, ce
 * qui permet de mesurer la qualité du balisage marchand par marchand.
 */
/**
 * Le texte visible d'une page, sans le code qui l'entoure.
 *
 * Sert à vérifier qu'un prix trouvé ailleurs — dans l'état embarqué, ou par
 * un modèle — s'affiche VRAIMENT à l'acheteur. Un catalogue interne contient
 * des prix d'achat, des prix barrés d'anciennes promotions et des tarifs
 * d'autres pays : les prendre pour argent comptant reviendrait à publier un
 * prix que personne ne voit sur le site.
 */
function texteVisible(html) {
  return String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");
}

/**
 * Ce prix s'écrit-il quelque part dans ce texte ?
 *
 * Garde-fou partagé par l'état embarqué et par la lecture assistée. On
 * cherche la valeur telle qu'elle s'écrit — virgule ou point, milliers
 * espacés ou non — parce qu'un prix plausible mais absent de la page est
 * pire qu'une absence de prix : il devient une référence, puis une remise,
 * puis une carte qui ment.
 */
function prixPresent(prix, texte) {
  if (!Number.isFinite(prix) || prix <= 0) return false;
  const entier = Math.floor(prix);
  const centimes = Math.round((prix - entier) * 100);
  const mille = String(entier).replace(/\B(?=(\d{3})+(?!\d))/g, "[\\s\\u00a0.]?");
  const cts = String(centimes).padStart(2, "0");
  const motif = centimes
    ? new RegExp(`${mille}\\s*[.,]\\s*${cts}`)
    : new RegExp(`${mille}(?![\\d.,]*[1-9])`);
  return motif.test(texte);
}

/* Les clés sous lesquelles un prix se cache dans un état applicatif. Elles
   varient d'un site à l'autre, mais pas tant que ça. */
const CLES_PRIX = /^(?:price|prix|currentprice|saleprice|finalprice|sellingprice|pricevalue|amount|value)$/i;
const CLES_NOM = /^(?:name|nom|title|titre|productname|displayname|label)$/i;
const CLES_REF = /^(?:listprice|regularprice|oldprice|wasprice|strikeprice|rrp|priceold|originalprice|prixbarre)$/i;

/**
 * Le produit tel que l'application de la page le connaît.
 *
 * QUATRIÈME STRATÉGIE, ET LA PLUS PAYANTE AUJOURD'HUI.
 *
 * Les trois premières — JSON-LD, microdata, OpenGraph — supposent que le
 * marchand décrit son produit POUR LES ROBOTS. Onze enseignes du registre ne
 * le font pas : Aldi, Free, Ikea, Leroy Merlin, Kiabi, Vinted, Marionnaud,
 * Nocibé, Momox, Feu Vert, Midas listent leurs fiches, servent leurs pages,
 * et n'y balisent rien.
 *
 * Mais elles sont bâties en React ou en Nuxt, et ces cadres embarquent l'état
 * complet de la page dans un `<script type="application/json">` pour que le
 * navigateur reprenne la main sans re-télécharger. Le produit y est en
 * entier — c'est la donnée dont le site se sert lui-même pour afficher le
 * prix, donc la plus fiable qui soit.
 *
 * Et c'est gratuit. On a failli payer un modèle pour lire ce que la page
 * donnait déjà.
 */
function produitDepuisEtat(html) {
  const visible = texteVisible(html);
  const blocs = [
    ...String(html).matchAll(
      /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi
    ),
  ].map((m) => m[1]);
  if (!blocs.length) return null;

  let meilleur = null;
  for (const brut of blocs) {
    // Un état applicatif pèse couramment plusieurs mégaoctets ; au-delà on
    // renonce plutôt que de bloquer le thread qui sert le site.
    if (brut.length > 4 * 1024 * 1024) continue;
    let racine;
    try {
      racine = JSON.parse(brut);
    } catch {
      continue;
    }
    const trouve = chercherProduit(racine, visible);
    // Le prix le plus élevé qui soit VISIBLE l'emporte : les états
    // embarquent souvent le prix unitaire d'une déclinaison à côté du prix
    // affiché, et c'est celui de la fiche qui nous intéresse.
    if (trouve && (!meilleur || trouve.prix > meilleur.prix)) meilleur = trouve;
  }
  return meilleur;
}

/** Parcourt un état applicatif à la recherche d'un nœud « produit ». */
function chercherProduit(racine, visible) {
  const pile = [racine];
  let vus = 0;
  let trouve = null;
  while (pile.length && vus < 200000) {
    const noeud = pile.pop();
    vus++;
    if (!noeud || typeof noeud !== "object") continue;
    if (Array.isArray(noeud)) {
      for (const v of noeud) pile.push(v);
      continue;
    }

    let prix = null;
    let nom = null;
    let ref = null;
    for (const [cle, valeur] of Object.entries(noeud)) {
      if (valeur && typeof valeur === "object") pile.push(valeur);
      else if (CLES_PRIX.test(cle)) {
        const n = nombre(valeur);
        // Le garde-fou : un prix qui ne s'affiche pas n'est pas le prix.
        if (n && prixPresent(n, visible) && (!prix || n > prix)) prix = n;
      } else if (CLES_NOM.test(cle) && typeof valeur === "string" && valeur.length > 3) {
        if (!nom) nom = valeur;
      } else if (CLES_REF.test(cle)) {
        const n = nombre(valeur);
        if (n && (!ref || n > ref)) ref = n;
      }
    }

    if (prix && nom && (!trouve || prix > trouve.prix)) {
      trouve = {
        nom: String(nom).slice(0, 200),
        description: null,
        image: null,
        marque: null,
        prix,
        prixReference: ref && ref > prix && prixPresent(ref, visible) ? ref : null,
        devise: "EUR",
        disponible: null,
        finOffre: null,
        debutOffre: null,
        caracteristiques: [],
        etat: "neuf",
        sku: null,
        source: "etat",
      };
    }
  }
  return trouve;
}

function produitDepuisHtml(html) {
  const produit = trouverProduit(extraireJsonLd(html));
  const offre = produit ? trouverOffre(produit) : null;
  const prix = offre ? nombre(offre.price) : null;

  if (produit && prixValide(prix)) {
    const dispo = String(premiere(offre.availability, true) || "");
    return {
      nom: nomFiable(premiere(produit.name), html),
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

  /* L'état embarqué passe AVANT OpenGraph : og:price est souvent absent ou
     périmé sur ces sites, alors que l'état est ce que la page affiche. */
  const repli =
    produitDepuisMicrodata(html) || produitDepuisEtat(html) || produitDepuisOpenGraph(html);
  if (repli) repli.nom = nomFiable(repli.nom, html);
  return repli;
}

module.exports = {
  prixValide,
  PRIX_MAX,
  extraireJsonLd,
  produitDepuisEtat,
  texteVisible,
  prixPresent,
  decoderEntites,
  nomFiable,
  produitsDepuisHtml,
  produitDepuisHtml,
  produitDepuisOpenGraph,
  produitDepuisMicrodata,
};
