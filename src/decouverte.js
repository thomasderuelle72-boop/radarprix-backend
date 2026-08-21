// decouverte.js — Trouver les fiches produits tout seul, sans clé ni saisie.
//
// Le problème : la surveillance ne peut relire que les fiches qu'on lui
// donne, et les lui coller à la main n'est pas un produit. Les flux
// d'affiliation résoudraient la question, mais ils sont conditionnés à
// l'acceptation de chaque programme — ce qui peut prendre des semaines.
//
// Or les marchands publient déjà la liste exhaustive de leurs fiches : c'est
// le rôle du sitemap, que tout site marchand expose pour être indexé. Le
// chemin est annoncé dans robots.txt, le format est normalisé, et il est
// destiné à être lu par des machines. Rien à demander à personne.
//
// Un sitemap de grande enseigne contient des centaines de milliers d'URL, la
// plupart sans intérêt ici (pages éditoriales, catégories, aide). D'où deux
// garde-fous : on ne descend que d'un niveau dans l'index, et on ne retient
// que les adresses qui ressemblent à des fiches produits.
const zlib = require("zlib");
const cheerio = require("cheerio");
const { recupererPage } = require("./fetchPage");


/* Ce qui distingue une fiche produit d'une page de catégorie. Chaque
   marchand a sa convention, et se fier à un motif unique raterait la moitié
   des sites. On teste donc plusieurs formes courantes :
     /p/…            très répandu
     /f-xxx-yyy.html Cdiscount
     /a1234567/…     Fnac
     /ref/1234567    Boulanger
     …-p-1234.html   variantes diverses
   Un identifiant numérique long est le signal le plus fiable : une page de
   catégorie n'en porte presque jamais. */
const MOTIFS_FICHE = [
  /\/p\/[^/]+/i,
  /\/f-\d+/i,
  /\/a\d{4,}/i,
  /\/ref\/\d{4,}/i,
  /-p-\d{3,}/i,
  /\/product\//i,
  /\/produit\//i,
  /\/dp\/[A-Z0-9]{8,}/i,
  /\/\d{6,}\.html?$/i,
];

/** L'adresse ressemble-t-elle à une fiche produit ? */
function ressembleAFiche(url) {
  return MOTIFS_FICHE.some((m) => m.test(url));
}

/** Décompresse si le contenu est gzippé — beaucoup de sitemaps le sont. */
function texteDe(brut) {
  if (typeof brut === "string") return brut;
  const buffer = Buffer.from(brut);
  // 0x1f8b : signature gzip.
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return zlib.gunzipSync(buffer).toString("utf8");
  return buffer.toString("utf8");
}

/**
 * Adresses des sitemaps d'un domaine, telles que le marchand les annonce.
 *
 * On lit robots.txt plutôt que de deviner /sitemap.xml : c'est là que la
 * norme veut que ce soit déclaré, et les grandes enseignes découpent leur
 * sitemap en plusieurs fichiers dont les noms ne s'inventent pas.
 */
async function sitemapsDe(domaine, { fetcher = fetch } = {}) {
  const racine = domaine.startsWith("http") ? domaine : `https://${domaine}`;
  let robots;
  try {
    // Par le récupérateur à deux étages, et non par un fetch direct : les
    // marchands qui bloquent les centres de données bloquent aussi leur
    // robots.txt. On échouait alors dès la première étape, pour se rabattre
    // sur une adresse devinée — souvent fausse chez les grandes enseignes,
    // qui découpent leur sitemap en plusieurs fichiers aux noms arbitraires.
    ({ html: robots } = await recupererPage(`${racine}/robots.txt`, { fetcher }));
  } catch {
    // Sans robots.txt lisible, on tente l'emplacement conventionnel plutôt
    // que d'abandonner : il est correct dans la majorité des cas.
    return [`${racine}/sitemap.xml`];
  }

  const declares = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1].trim());
  return declares.length > 0 ? declares : [`${racine}/sitemap.xml`];
}

/**
 * Extrait les URL d'un sitemap. Renvoie séparément les fiches et les
 * sous-sitemaps, un index de sitemaps ne contenant que des renvois.
 */
function lireSitemap(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const index = $("sitemapindex > sitemap > loc")
    .map((_, el) => $(el).text().trim())
    .get();
  const pages = $("urlset > url > loc")
    .map((_, el) => $(el).text().trim())
    .get();
  return { index, pages };
}

/**
 * Découvre des fiches produits chez un marchand.
 *
 * @param {string} domaine        ex. "www.cdiscount.com"
 * @param {object} [opts]
 * @param {number} [opts.limite]  nombre maximum de fiches à rapporter
 * @param {number} [opts.maxSitemaps] sous-sitemaps explorés au maximum
 * @returns {Promise<{urls: string[], sitemapsLus: number, erreurs: string[]}>}
 */
async function decouvrirFiches(domaine, { limite = 50, maxSitemaps = 3, fetcher = fetch } = {}) {
  const erreurs = [];
  const trouvees = new Set();
  let sitemapsLus = 0;

  const aExplorer = await sitemapsDe(domaine, { fetcher });

  while (aExplorer.length > 0 && trouvees.size < limite && sitemapsLus < maxSitemaps + 1) {
    const url = aExplorer.shift();
    let xml;
    try {
      // Les sitemaps sont souvent protégés au même titre que les fiches :
      // on passe par le même récupérateur à deux étages.
      const { html } = await recupererPage(url, { fetcher });
      xml = texteDe(html);
      sitemapsLus++;
    } catch (e) {
      erreurs.push(`${url} : ${e.message}`);
      continue;
    }

    let lu;
    try {
      lu = lireSitemap(xml);
    } catch (e) {
      erreurs.push(`${url} : XML illisible (${e.message})`);
      continue;
    }

    for (const page of lu.pages) {
      if (trouvees.size >= limite) break;
      if (ressembleAFiche(page)) trouvees.add(page);
    }

    // On empile les sous-sitemaps seulement si l'on n'a pas déjà de quoi
    // faire : descendre dans un index de deux cents fichiers pour trouver
    // cinquante fiches serait absurde.
    if (trouvees.size < limite) {
      for (const enfant of lu.index.slice(0, maxSitemaps)) aExplorer.push(enfant);
    }
  }

  return { urls: [...trouvees], sitemapsLus, erreurs };
}

/**
 * Rejoue la découverte en rapportant chaque étape, pour savoir où elle casse.
 *
 * Écrit parce que « rien ne s'affiche » ne dit pas si le marchand a refusé la
 * requête, si son sitemap est introuvable, ou si ses adresses de fiches ne
 * ressemblent à aucun des motifs reconnus. Les trois se corrigent
 * différemment, et sans ce détail on ajoute du code au hasard.
 *
 * L'échantillon d'adresses NON retenues est le plus utile : il montre la
 * forme réelle des URL du marchand, donc le motif qui manque.
 */
async function diagnostiquer(domaine, { fetcher = fetch } = {}) {
  const etapes = [];
  const racine = domaine.startsWith("http") ? domaine : `https://${domaine}`;

  let robotsOk = false;
  try {
    const { via } = await recupererPage(`${racine}/robots.txt`, { fetcher });
    robotsOk = true;
    etapes.push({ etape: "robots.txt", ok: true, detail: `lu (${via})` });
  } catch (e) {
    etapes.push({ etape: "robots.txt", ok: false, detail: e.message });
  }

  let sitemaps = [];
  try {
    sitemaps = await sitemapsDe(domaine, { fetcher });
    etapes.push({
      etape: "sitemaps déclarés",
      ok: sitemaps.length > 0,
      detail: robotsOk ? `${sitemaps.length} déclaré(s)` : `${sitemaps.length} deviné(s), robots.txt illisible`,
      exemples: sitemaps.slice(0, 3),
    });
  } catch (e) {
    etapes.push({ etape: "sitemaps déclarés", ok: false, detail: e.message });
    return { domaine, etapes, urls: [] };
  }

  let toutesLesUrls = [];
  let aExplorer = [...sitemaps];
  let lus = 0;

  while (aExplorer.length > 0 && lus < 4 && toutesLesUrls.length === 0) {
    const url = aExplorer.shift();
    try {
      const { html, via } = await recupererPage(url, { fetcher });
      lus++;
      const { index, pages } = lireSitemap(texteDe(html));
      etapes.push({
        etape: `sitemap ${lus}`,
        ok: true,
        detail: `${pages.length} page(s), ${index.length} sous-sitemap(s) (${via})`,
        exemples: [url],
      });
      if (pages.length > 0) toutesLesUrls = pages;
      else aExplorer.unshift(...index.slice(0, 3));
    } catch (e) {
      lus++;
      etapes.push({ etape: `sitemap ${lus}`, ok: false, detail: e.message, exemples: [url] });
    }
  }

  const retenues = toutesLesUrls.filter(ressembleAFiche);
  const ecartees = toutesLesUrls.filter((u) => !ressembleAFiche(u));
  etapes.push({
    etape: "reconnaissance des fiches",
    ok: retenues.length > 0,
    detail: `${retenues.length} retenue(s) sur ${toutesLesUrls.length} adresse(s)`,
  });

  return {
    domaine,
    etapes,
    // Les deux échantillons ensemble suffisent à décider quoi corriger.
    exemplesRetenus: retenues.slice(0, 5),
    exemplesEcartes: ecartees.slice(0, 8),
  };
}

module.exports = { decouvrirFiches, sitemapsDe, lireSitemap, ressembleAFiche, texteDe, diagnostiquer, MOTIFS_FICHE };
