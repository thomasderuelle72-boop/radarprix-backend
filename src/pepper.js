// pepper.js — Lecture des sites de bons plans bâtis sur Pepper.
//
// Dealabs, Mydealz, Hotukdeals, Chollometro et leurs jumeaux tournent tous
// sur la même plateforme, et leurs pages embarquent l'état complet de
// chaque bon plan en JSON, pour que leur interface s'en serve. On y trouve,
// déjà structuré, tout ce qu'une carte RadarPrix doit montrer :
//
//   prix payé · prix de référence (nextBestPrice) · marchand · image ·
//   catégorie · date de fin · code promo · température communautaire
//
// L'intérêt par rapport au flux RSS du même site est décisif : le flux ne
// publie AUCUN prix de référence — vérifié sur trente articles, zéro — donc
// aucun pourcentage de remise. La page en porte un pour la quasi-totalité
// des offres, et en rend cinquante d'un coup au lieu de trente.
//
// La température est la note que la communauté du site donne au bon plan.
// C'est un signal de qualité qu'aucune mesure de prix ne remplace : il dit
// si l'offre vaut le détour pour de vrais acheteurs, pas seulement si elle
// est moins chère qu'ailleurs.

const { categorieDepuisLibelle } = require("./categories");
const { lienMarchand, marchandDepuisDomaine } = require("./marchands");

const HOTES = [
  "dealabs.com", "mydealz.de", "hotukdeals.com", "pepper.pl",
  "chollometro.com", "pepper.it", "preisjaeger.at", "pepper.ru",
];

/** Le site est-il bâti sur Pepper ? */
function estPepper(url) {
  try {
    const hote = new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase();
    return HOTES.some((h) => hote === h || hote.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Objet JSON qui entoure une position donnée dans un texte.
 *
 * Un simple comptage d'accolades ne suffit pas : les titres des bons plans
 * contiennent des accolades et des guillemets échappés, qui décaleraient le
 * compte et rendraient un fragment illisible. On suit donc l'état « dans une
 * chaîne » et les échappements, comme le ferait un analyseur.
 */
function objetAutour(texte, position) {
  const debut = reculerJusquAuDebut(texte, position);
  if (debut === -1) return null;

  let profondeur = 0;
  let dansChaine = false;
  let echappe = false;
  for (let i = debut; i < texte.length; i++) {
    const c = texte[i];
    if (echappe) { echappe = false; continue; }
    if (c === "\\") { echappe = true; continue; }
    if (c === '"') { dansChaine = !dansChaine; continue; }
    if (dansChaine) continue;
    if (c === "{") profondeur++;
    else if (c === "}") {
      profondeur--;
      if (profondeur === 0) return texte.slice(debut, i + 1);
    }
  }
  return null;
}

/** Remonte à l'accolade ouvrante de l'objet contenant `position`. */
function reculerJusquAuDebut(texte, position) {
  let profondeur = 0;
  for (let i = position; i >= 0; i--) {
    const c = texte[i];
    // En marche arrière on ne peut pas suivre l'état des chaînes de façon
    // fiable ; on s'appuie sur l'équilibre des accolades, qui suffit ici
    // parce qu'on repart d'une clé JSON et non d'un texte libre.
    if (c === "}") profondeur++;
    else if (c === "{") {
      if (profondeur === 0) return i;
      profondeur--;
    }
  }
  return -1;
}

/** Tous les bons plans décrits dans une page Pepper. */
function extraireFils(html) {
  const texte = String(html || "");
  const vus = new Set();
  const fils = [];

  for (const m of texte.matchAll(/"threadId"\s*:\s*"?(\d+)"?/g)) {
    if (vus.has(m[1])) continue;
    const brut = objetAutour(texte, m.index);
    if (!brut) continue;
    let fil;
    try {
      fil = JSON.parse(brut);
    } catch {
      continue; // fragment tronqué : on passe au suivant
    }
    // L'objet doit être le bon plan lui-même, pas un commentaire ou un vote
    // qui référencerait le même identifiant.
    if (!fil || fil.title === undefined || fil.price === undefined) continue;
    vus.add(m[1]);
    fils.push(fil);
  }
  return fils;
}

/**
 * Adresse de l'image d'un bon plan.
 *
 * Le serveur d'images n'accepte qu'un jeu fixe de tailles : 300×300 est la
 * seule qui réponde parmi celles essayées, les autres rendent un 404.
 */
function urlImage(image, hote = "static-pepper.dealabs.com") {
  if (!image || !image.path || !image.name) return null;
  const fichier = image.uid || `${image.name}.${image.ext || "jpg"}`;
  return `https://${hote}/${image.path}/${image.name}/re/300x300/qt/70/${fichier}`;
}

const nombre = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** Horodatage Pepper (secondes) en date ISO. */
function dateDe(v) {
  const t = v && typeof v === "object" ? v.timestamp : v;
  if (!Number.isFinite(Number(t)) || Number(t) <= 0) return null;
  return new Date(Number(t) * 1000).toISOString();
}

/**
 * Bon plan Pepper ramené à la forme d'offre que la détection attend.
 *
 * Rend null pour une offre expirée ou sans prix : le site ne doit pas
 * afficher ce que plus personne ne peut acheter.
 */
function offreDePepper(fil, { hoteImages } = {}) {
  const prix = nombre(fil.price);
  if (!prix || fil.isExpired) return null;

  const reference = nombre(fil.nextBestPrice);

  // Jamais un lien vers l'agrégateur. Il ne publie pas l'URL du produit —
  // c'est son fonds de commerce — mais il dit qui vend, et c'est chez ce
  // marchand qu'on envoie l'acheteur. Renvoyer sur la page du bon plan
  // reviendrait à offrir notre visiteur à un concurrent.
  const lien = lienMarchand({
    domaine: fil.linkHost || null,
    titre: fil.title,
  });

  return {
    externalId: String(fil.threadId),
    name: String(fil.title || "").slice(0, 200),
    price: prix,
    // Le prix « ailleurs » relevé par la communauté : c'est une référence
    // annoncée, pas une mesure RadarPrix, et elle est étiquetée comme telle.
    refPriceAnnonce: reference && reference > prix ? reference : null,
    url: lien,
    // Le registre l'emporte sur le libellé de la source quand il connaît
    // l'enseigne : « Micromania Zing » et « Micromania » désignent la même,
    // et deux orthographes feraient deux marchands sur le site.
    seller:
      (marchandDepuisDomaine(fil.linkHost) || {}).nom ||
      (fil.merchant && fil.merchant.merchantName) ||
      null,
    img: urlImage(fil.mainImage, hoteImages),
    category: categorieDepuisLibelle(fil.mainGroup && fil.mainGroup.threadGroupName),
    finOffre: dateDe(fil.endDate),
    debutOffre: dateDe(fil.startDate),
    voucherCode: fil.voucherCode || null,
    // Note communautaire, reportée telle quelle pour le classement.
    temperature: Number.isFinite(Number(fil.temperature)) ? Number(fil.temperature) : null,
    commentaires: Number.isFinite(Number(fil.commentCount)) ? Number(fil.commentCount) : 0,
    itemCondition: "neuf",
    balisage: "pepper",
  };
}

module.exports = { estPepper, extraireFils, offreDePepper, urlImage };
