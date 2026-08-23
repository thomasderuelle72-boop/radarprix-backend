// awin.js — Catalogues produits des marchands, via le réseau d'affiliation.
//
// POURQUOI CE MODULE EXISTE
//
// Aller chercher les prix directement chez les marchands français ne marche
// pas. Mesuré, pas supposé : douze fiches produits sondées chez les grandes
// enseignes, une seule répond en HTTP direct. Les autres rendent 403
// (Cloudflare, DataDome) ou chargent tout en JavaScript. Vingt-huit pages
// « promotions » sondées : zéro produit extrait.
//
// Un marchand qui refuse un robot anonyme publie en revanche volontiers son
// catalogue entier à ses partenaires affiliés — c'est son intérêt. Le flux
// contient exactement ce qu'une carte RadarPrix doit montrer :
//
//   nom · description · image · prix · prix conseillé · EAN · marque ·
//   catégorie · disponibilité · et un lien qui mène CHEZ LE MARCHAND
//
// D'où l'indépendance : plus d'agrégateur entre le marchand et nous, et un
// lien de sortie qui n'enrichit personne d'autre.
//
// CE QU'IL FAUT POUR L'ACTIVER
//
//   AWIN_PUBLISHER_ID   identifiant de compte éditeur
//   AWIN_API_TOKEN      jeton OAuth2 (Awin → Compte → Jetons API)
//   AWIN_FEED_KEY       clé des catalogues produits, distincte du jeton
//
// Sans ces variables, le module reste silencieux et rien ne casse.

const API = "https://api.awin.com";
const CATALOGUES = "https://productdata.awin.com/datafeed";

/* Une variable déclarée mais vide n'est pas la même chose qu'une variable
   absente : la première fait croire que tout est en place. Le diagnostic
   nomme celles qui manquent, une par une. */
const manquantes = () =>
  ["AWIN_PUBLISHER_ID", "AWIN_API_TOKEN"].filter((v) => !String(process.env[v] || "").trim());

const configure = () => manquantes().length === 0;

/** Appel authentifié à l'API éditeur. Lève un message lisible sur refus. */
async function appel(chemin) {
  const rep = await fetch(`${API}${chemin}`, {
    headers: { Authorization: `Bearer ${process.env.AWIN_API_TOKEN}` },
    signal: AbortSignal.timeout(20000),
  });
  if (rep.status === 401) throw new Error("jeton Awin refusé (401)");
  if (!rep.ok) throw new Error(`Awin ${chemin} : HTTP ${rep.status}`);
  return rep.json();
}

/** Les programmes marchands auxquels le compte est affilié. */
async function programmesRejoints() {
  const id = process.env.AWIN_PUBLISHER_ID;
  const liste = await appel(`/publishers/${id}/programmes?relationship=joined`);
  return (Array.isArray(liste) ? liste : []).map((p) => ({
    id: p.id,
    nom: p.name,
    domaine: (p.displayUrl || "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, ""),
    devise: p.currencyCode || "EUR",
  }));
}

/* Colonnes demandées au catalogue. Awin en propose plus de cent ; n'en
   prendre que ce qu'on affiche divise le poids du fichier par dix, et un
   catalogue se télécharge à chaque scan. */
const COLONNES = [
  "aw_deep_link", "product_name", "merchant_product_id", "merchant_name", "merchant_id",
  "aw_image_url", "description", "search_price", "rrp_price", "store_price",
  "currency", "in_stock", "brand_name", "ean", "category_name", "delivery_cost",
];

/**
 * Adresse d'un catalogue.
 *
 * Le format `fid` accepte plusieurs identifiants séparés par des virgules :
 * un seul appel rapporte le catalogue de plusieurs marchands.
 */
function urlCatalogue(feedIds) {
  const cle = process.env.AWIN_FEED_KEY;
  const ids = [].concat(feedIds).join(",");
  return `${CATALOGUES}/list/apikey/${cle}/language/fr/fid/${ids}/columns/${COLONNES.join(",")}/format/csv/delimiter/%7C/compression/gzip/`;
}

/**
 * Découpe une ligne CSV en respectant les guillemets.
 *
 * Les descriptions produits contiennent des séparateurs et des guillemets ;
 * un simple split() sur le délimiteur décalerait toutes les colonnes
 * suivantes, et le prix se retrouverait dans la marque.
 */
function decouper(ligne, sep) {
  const cases = [];
  let courant = "";
  let entreGuillemets = false;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    // Un guillemet ne délimite que s'il OUVRE le champ. Ailleurs c'est un
    // caractère comme un autre : « Écran 27" » est un titre courant, et le
    // prendre pour une ouverture avalait les séparateurs suivants — le
    // prix se retrouvait dans la marque.
    if (c === '"' && (entreGuillemets || courant === "")) {
      // Un guillemet doublé à l'intérieur d'un champ cité est un guillemet.
      if (entreGuillemets && ligne[i + 1] === '"') { courant += '"'; i++; }
      else entreGuillemets = !entreGuillemets;
    } else if (c === sep && !entreGuillemets) {
      cases.push(courant); courant = "";
    } else courant += c;
  }
  cases.push(courant);
  return cases;
}

const nombre = (v) => {
  const n = parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Convertit un catalogue CSV en offres.
 *
 * Les colonnes sont retrouvées PAR LEUR NOM, jamais par leur position :
 * Awin en ajoute et en réordonne, et un index figé finirait par lire la
 * description dans la colonne du prix.
 */
function offresDuCatalogue(csv, sep = "|") {
  const lignes = String(csv || "").split(/\r?\n/).filter((l) => l.trim());
  if (lignes.length < 2) return [];

  const entete = decouper(lignes[0], sep).map((c) => c.trim().toLowerCase());
  const col = (nom) => entete.indexOf(nom);
  const iNom = col("product_name");
  const iPrix = col("search_price");
  if (iNom === -1 || iPrix === -1) return [];

  const lire = (cases, nom) => {
    const i = col(nom);
    return i === -1 ? null : (cases[i] || "").trim() || null;
  };

  const offres = [];
  for (const ligne of lignes.slice(1)) {
    const cases = decouper(ligne, sep);
    const nom = (cases[iNom] || "").trim();
    const prix = nombre(cases[iPrix]);
    if (!nom || !prix) continue;

    // Le prix conseillé n'est retenu que s'il dépasse le prix payé : les
    // catalogues le recopient souvent à l'identique, ce qui afficherait
    // une remise de zéro pour cent.
    const conseille = nombre(lire(cases, "rrp_price")) || nombre(lire(cases, "store_price"));
    const stock = lire(cases, "in_stock");

    offres.push({
      externalId: lire(cases, "merchant_product_id") || lire(cases, "ean") || nom.slice(0, 120),
      name: nom.slice(0, 200),
      price: prix,
      refPriceAnnonce: conseille && conseille > prix ? conseille : null,
      // Le lien d'affiliation mène chez le marchand : c'est tout l'intérêt.
      url: lire(cases, "aw_deep_link"),
      seller: lire(cases, "merchant_name"),
      img: lire(cases, "aw_image_url"),
      description: (lire(cases, "description") || "").slice(0, 1200) || null,
      marque: lire(cases, "brand_name"),
      ean: lire(cases, "ean"),
      libelleCategorie: lire(cases, "category_name"),
      disponible: stock === null ? null : /^(1|true|yes|oui)$/i.test(stock),
      caracteristiques: [],
      itemCondition: "neuf",
      balisage: "awin",
    });
  }
  return offres;
}

/* ── Codes promo et promotions du réseau ─────────────────────────────
   Le service qui manquait au site : le type « code » existe en base depuis
   l'origine et n'avait jamais été alimenté.

   Contrat de l'API, vérifié dans plusieurs intégrations publiques plutôt que
   deviné — la documentation d'Awin est inaccessible depuis ici :

     POST https://api.awin.com/publisher/{id}/promotions

   Trois pièges, et c'est là que la plupart des intégrations se cassent :

     · « publisher » au SINGULIER. L'ancien chemin `/publishers/{id}/promotions`
       en GET n'existe plus ; plusieurs projets publics l'appellent encore et
       reçoivent un 404 qu'ils prennent pour un compte vide.
     · le jeton se passe BRUT dans Authorization, sans « Bearer ». On envoie
       aussi accessToken en paramètre, qu'Awin accepte : deux chances plutôt
       qu'un échec silencieux.
     · vingt appels par minute. La pagination attend donc entre deux pages.

   L'intérêt décisif : chaque promotion porte `urlTracking`, un lien qui mène
   VRAIMENT chez le marchand. Sur les 126 offres publiées au 23 août 2026,
   une seule ouvrait autre chose qu'une recherche. */

const PAGE_PROMOS = 200;
const ATTENTE_ENTRE_PAGES = 3500;

async function pagePromotions(corps) {
  const jeton = process.env.AWIN_API_TOKEN;
  const url = `${API}/publisher/${process.env.AWIN_PUBLISHER_ID}/promotions?accessToken=${encodeURIComponent(jeton)}`;
  const rep = await fetch(url, {
    method: "POST",
    headers: { Authorization: jeton, "Content-Type": "application/json" },
    body: JSON.stringify(corps),
    signal: AbortSignal.timeout(30000),
  });
  if (rep.status === 401 || rep.status === 403) throw new Error("jeton Awin refusé pour les promotions");
  if (!rep.ok) throw new Error(`promotions Awin : HTTP ${rep.status}`);
  return rep.json();
}

/**
 * Les promotions et codes promo publiés sur le réseau.
 *
 * `membership` vaut « joined » pour les seuls programmes rejoints, ou
 * « notjoined » pour voir ce que proposent les autres. Awin sert les deux :
 * un site peut donc afficher des codes avant d'être accepté nulle part —
 * mais sans lien d'affiliation utilisable sur les programmes non rejoints.
 */
async function promotions({ membership = "joined", type = null, regionCodes = ["FR"], maxPages = 5 } = {}) {
  if (!configure()) return [];

  const filtres = { membership, regionCodes };
  if (type) filtres.type = type;

  const toutes = [];
  let curseur = null;
  for (let page = 0; page < maxPages; page++) {
    const corps = { filters: filtres, pagination: { pageSize: PAGE_PROMOS } };
    if (curseur) corps.pagination.cursor = curseur;

    const rep = await pagePromotions(corps);
    const lot = Array.isArray(rep && rep.data) ? rep.data : [];
    toutes.push(...lot);

    curseur = rep && rep.pagination ? rep.pagination.cursor : null;
    if (!curseur || lot.length === 0) break;
    await new Promise((r) => setTimeout(r, ATTENTE_ENTRE_PAGES));
  }
  return toutes.map(enOffrePromo).filter(Boolean);
}

/** Une promotion Awin ramenée à la forme que le reste du site manipule. */
function enOffrePromo(p) {
  const marchand = (p.advertiser && p.advertiser.name) || null;
  const titre = (p.title || p.description || "").trim();
  // Sans marchand ni lien, la carte ne serait pas actionnable.
  if (!titre || !marchand || !p.urlTracking) return null;

  const code = p.voucher && p.voucher.code ? String(p.voucher.code).trim() : null;
  return {
    externalId: String(p.promotionId),
    name: titre.slice(0, 200),
    description: (p.description || "").slice(0, 1200) || null,
    seller: marchand,
    url: p.urlTracking,
    // Un code promo se distingue d'une promotion simple : l'un se copie,
    // l'autre s'applique tout seul.
    typePromo: code ? "code" : "promo",
    voucherCode: code,
    startsAt: p.startDate || null,
    expiresAt: p.endDate || null,
    // Une promotion n'a pas de prix : elle porte une réduction, pas un tarif.
    price: null,
    lienType: "produit",
  };
}

/**
 * Diagnostic au démarrage : le compte répond-il ?
 *
 * Une intégration qui dépend de trois variables d'environnement doit dire
 * tout de suite laquelle manque, plutôt que d'échouer en silence au
 * prochain scan.
 */
async function diagnostic() {
  const vides = manquantes();
  if (vides.length) return { actif: false, raison: `${vides.join(" et ")} vide(s) ou absente(s)` };
  try {
    const programmes = await programmesRejoints();

    /* Les codes promo ne sortaient qu'au scan, toutes les trois heures :
       une erreur d'intégration restait invisible jusque-là. On les compte
       au démarrage, sur une seule page, pour que le journal dise tout de
       suite si l'API répond — et combien elle rend selon qu'on interroge
       les programmes rejoints ou l'ensemble du réseau. */
    const compter = async (membership) => {
      try {
        return (await promotions({ membership, maxPages: 1 })).length;
      } catch (e) {
        return `erreur : ${e.message}`;
      }
    };

    return {
      actif: true,
      programmes: programmes.length,
      catalogues: Boolean(process.env.AWIN_FEED_KEY),
      exemples: programmes.slice(0, 5).map((p) => p.nom),
      promosRejoints: await compter("joined"),
      promosReseau: await compter("notjoined"),
    };
  } catch (e) {
    return { actif: false, raison: e.message };
  }
}

module.exports = { configure, programmesRejoints, promotions, enOffrePromo, offresDuCatalogue, urlCatalogue, diagnostic, COLONNES };
