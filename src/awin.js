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

const configure = () => Boolean(process.env.AWIN_API_TOKEN && process.env.AWIN_PUBLISHER_ID);

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

/**
 * Diagnostic au démarrage : le compte répond-il ?
 *
 * Une intégration qui dépend de trois variables d'environnement doit dire
 * tout de suite laquelle manque, plutôt que d'échouer en silence au
 * prochain scan.
 */
async function diagnostic() {
  if (!configure()) return { actif: false, raison: "AWIN_API_TOKEN ou AWIN_PUBLISHER_ID absent" };
  try {
    const programmes = await programmesRejoints();
    return {
      actif: true,
      programmes: programmes.length,
      catalogues: Boolean(process.env.AWIN_FEED_KEY),
      exemples: programmes.slice(0, 5).map((p) => p.nom),
    };
  } catch (e) {
    return { actif: false, raison: e.message };
  }
}

module.exports = { configure, programmesRejoints, offresDuCatalogue, urlCatalogue, diagnostic, COLONNES };
