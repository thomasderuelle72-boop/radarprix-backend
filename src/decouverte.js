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
const { recupererPage } = require("./fetchPage");

/* Budget de temps global. Même avec un délai par requête, douze sitemaps
   lents mis bout à bout dépasseraient largement l'intervalle du cron. */
function budgetMs() {
  const n = parseInt(process.env.DECOUVERTE_BUDGET_MS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 90000;
}

/* Plafond de données par exploration. Constaté sur la facture Bright Data :
   94 Mo aspirés chez un seul marchand en un après-midi, pour 43 requêtes —
   soit plus de 2 Mo par sitemap. Les grandes enseignes publient des index
   volumineux, et rien n'obligeait à les télécharger jusqu'au bout.
   Le budget de temps ne protège pas de ça : un gros fichier arrive vite. */
/* Relu à chaque appel, et non figé au chargement du module : un réglage
   capturé à l'import ne peut plus être ajusté sans redéployer — deux tests
   l'ont révélé, ici et sur le délai d'expiration. */
function plafondOctets() {
  const n = parseInt(process.env.DECOUVERTE_MAX_OCTETS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 12 * 1024 * 1024;
}


/* ── Reconnaître une fiche produit ────────────────────────────────
   Première version : une liste de motifs positifs (/p/, /f-123, /a1234567…).
   Elle a échoué en production sur Cdiscount ET la Fnac — zéro adresse
   reconnue sur des sitemaps pourtant lus correctement.

   L'erreur était de méthode. Deviner un produit à partir de la FORME de son
   adresse, c'est réécrire un motif par marchand et le refaire à chaque
   refonte de site. Or nous disposons d'un juge autrement plus fiable : la
   page elle-même. Si elle porte un JSON-LD de type Product avec un prix,
   c'est une fiche produit ; sinon non, quelle que soit son adresse.

   On inverse donc la logique : au lieu de retenir ce qui ressemble à une
   fiche, on écarte ce qui n'en est manifestement pas une, et la lecture de
   la page tranche pour le reste. Une adresse retenue à tort échoue une fois
   à la lecture, se fait compter un échec, et finit désactivée — coût borné,
   contre un catalogue entier manqué avec l'approche inverse. */
const MOTIFS_HORS_FICHE = [
  /\/(aide|help|faq|contact|cgv|cgu|mentions|legal|privacy|cookies)\b/i,
  /\/(compte|account|login|connexion|panier|cart|checkout|commande)\b/i,
  /\/(blog|actualites|actualite|news|magazine|guide|conseils|dossier)\b/i,
  /\/(marques|brands|categorie|categories|category|rayon|univers|selection)\b/i,
  /\/(recherche|search|sitemap|plan-du-site|store|magasin|boutiques)\b/i,
  /\/(recrutement|carriere|jobs|presse|investisseurs|entreprise)\b/i,
  /\.(pdf|jpg|jpeg|png|gif|svg|xml|css|js)$/i,
];

/**
 * L'adresse peut-elle être une fiche produit ?
 *
 * Volontairement permissif : c'est la lecture du JSON-LD qui décidera pour
 * de bon. On exige seulement que l'adresse pointe vers quelque chose d'assez
 * profond pour être une fiche — une page d'accueil ou une section de premier
 * niveau n'en est jamais une.
 */
// Signaux qui désignent une fiche sans ambiguïté possible, quelle que soit
// la longueur du libellé qui suit. Ils passent avant toute autre règle : un
// /p/xy court reste une fiche, alors qu'un critère de longueur le rejetterait.
const SIGNAUX_FICHE = [
  /\/p\//i,
  /\/product\//i,
  /\/produit\//i,
  /\/dp\//i,
  /\/f-\d/i,
  /\/ref\//i,
  /\/a\d{4,}/i,
  /-p-\d{3,}/i,
];

function ressembleAFiche(url) {
  let chemin;
  try {
    chemin = new URL(url).pathname;
  } catch {
    return false;
  }

  if (MOTIFS_HORS_FICHE.some((m) => m.test(chemin))) return false;
  if (SIGNAUX_FICHE.some((m) => m.test(chemin))) return true;

  const segments = chemin.split("/").filter(Boolean);
  if (segments.length === 0) return false; // page d'accueil

  // Un identifiant numérique long est le signal le plus fiable qui soit :
  // une page de catégorie n'en porte presque jamais, une fiche presque
  // toujours (référence, EAN, identifiant interne).
  if (/\d{4,}/.test(chemin)) return true;

  // À défaut, une adresse profonde et terminale reste plausible. Deux
  // segments suffisent : beaucoup de marchands publient /categorie/nom-produit.
  const dernier = segments[segments.length - 1];
  return segments.length >= 2 && dernier.length >= 8 && /[a-z]/i.test(dernier);
}

// Conservé pour compatibilité : les tests historiques s'y réfèrent.
const MOTIFS_FICHE = MOTIFS_HORS_FICHE;

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
  // Extraction par expression régulière plutôt que par arbre DOM. Un sitemap
  // de grande enseigne pèse plusieurs mégaoctets et contient des dizaines de
  // milliers d'entrées : en construire la représentation complète coûte un
  // temps et une mémoire sans rapport avec le seul champ qu'on lit. Le
  // format est trop simple pour justifier ce prix.
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) =>
    m[1].replace(/&amp;/g, "&").trim()
  );

  // Un index ne contient que des renvois vers d'autres sitemaps, jamais des
  // pages : le type du document décide de la nature des adresses lues.
  const estIndex = /<sitemapindex[\s>]/i.test(xml.slice(0, 4000));
  return estIndex ? { index: locs, pages: [] } : { index: [], pages: locs };
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
async function decouvrirFiches(domaine, { limite = 50, maxSitemaps = 12, fetcher = fetch } = {}) {
  const erreurs = [];
  const trouvees = new Set();
  // Quelques adresses telles quelles, retenues ou non : sans elles, un
  // « 0 reconnue » ne dit pas à quoi ressemblent les adresses du marchand,
  // et on corrige à l'aveugle.
  const echantillonVu = [];
  let sitemapsLus = 0;

  const aExplorer = await sitemapsDe(domaine, { fetcher });
  const budget = budgetMs();
  const plafond = plafondOctets();
  const echeance = Date.now() + budget;
  let octetsLus = 0;

  while (aExplorer.length > 0 && trouvees.size < limite && sitemapsLus < maxSitemaps + 1) {
    if (Date.now() > echeance) {
      erreurs.push(`budget de ${Math.round(budget / 1000)} s dépassé — exploration interrompue`);
      break;
    }
    if (octetsLus > plafond) {
      erreurs.push(
        `plafond de ${Math.round(plafond / 1024 / 1024)} Mo atteint — exploration interrompue ` +
          `(${Math.round(octetsLus / 1024 / 1024)} Mo téléchargés)`
      );
      break;
    }
    const url = aExplorer.shift();
    let xml;
    try {
      // Les sitemaps sont souvent protégés au même titre que les fiches :
      // on passe par le même récupérateur à deux étages.
      const { html } = await recupererPage(url, { fetcher });
      octetsLus += typeof html === "string" ? html.length : (html?.byteLength ?? 0);
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
      if (echantillonVu.length < 5) echantillonVu.push(page);
      if (trouvees.size >= limite) break;
      if (ressembleAFiche(page)) trouvees.add(page);
    }

    // On empile les sous-sitemaps seulement si l'on n'a pas déjà de quoi
    // faire : descendre dans un index de deux cents fichiers pour trouver
    // cinquante fiches serait absurde.
    if (trouvees.size < limite) {
      // Les grands sites publient des dizaines de sous-sitemaps : produits,
      // pages éditoriales, magasins, marques… Descendre dans l'ordre du
      // fichier fait épuiser le budget sur des branches sans intérêt — c'est
      // ce qui est arrivé à la Fnac, quatre sitemaps lus sans une seule
      // fiche. On explore donc d'abord ceux dont le nom évoque un catalogue.
      const prometteur = (u) => /produit|product|item|catalog|offre|offer|shop|sku/i.test(u);
      const enfants = [...lu.index].sort((a, b) => Number(prometteur(b)) - Number(prometteur(a)));
      for (const enfant of enfants.slice(0, maxSitemaps)) aExplorer.push(enfant);
    }
  }

  return { urls: [...trouvees], sitemapsLus, erreurs, echantillonVu: echantillonVu.slice(0, 5) };
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
