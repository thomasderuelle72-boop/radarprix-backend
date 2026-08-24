// navigateur.js — Un client HTTP qui ressemble à un navigateur.
//
// POURQUOI CE MODULE EXISTE
//
// `catalogue.js` allait chercher ses pages avec un `fetch` nu portant un
// seul en-tête. Les protections des grandes enseignes françaises —
// Cloudflare, DataDome — classent une requête sur trois signaux :
//
//   1. l'IP        (réputation du réseau d'où part la requête)
//   2. l'empreinte TLS  (l'ordre des suites de chiffrement, JA3/JA4)
//   3. la forme des en-têtes  (lesquels, dans quel ordre, avec quelles valeurs)
//
// Le troisième est le SEUL que du code puisse changer sans rien louer. On
// commence donc par là, et on mesure — plutôt que de conclure d'avance que
// rien ne marchera.
//
// Ce que ce module ne fera jamais : contourner une protection qui nous
// refuse explicitement. Il envoie ce qu'un navigateur envoie, il respecte
// robots.txt, il s'annonce, et il ralentit quand on le lui demande.

/* Le jeu d'en-têtes d'un Chrome récent sur Windows. L'ordre compte : les
   empreintes d'en-têtes se lisent en séquence, et un ordre inhabituel est
   à lui seul un signal. */
const EN_TETES = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9," +
    "image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
  "sec-ch-ua": '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

/* Accept-Encoding n'est PAS déclaré ici, volontairement. undici le pose
   lui-même et décompresse la réponse ; l'annoncer à la main lui fait rendre
   des octets compressés qu'on lirait comme du texte binaire. Une heure
   perdue la première fois. */

/* Un pot à cookies par hôte. Beaucoup de protections posent un cookie à la
   première visite et refusent la seconde requête s'il ne revient pas — le
   `fetch` nu n'en gardait aucun, et repassait donc éternellement pour un
   premier visiteur suspect. */
const potACookies = new Map();

/* Dernier passage par hôte : deux requêtes collées sur le même domaine sont
   un signal de robot, et c'est aussi une question de correction. */
const dernierPassage = new Map();
const PAUSE_PAR_HOTE = 1000;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const hoteDe = (url) => {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return null;
  }
};

function lireCookies(reponse, hote) {
  // getSetCookie() rend les en-têtes séparés ; sans lui, plusieurs cookies
  // arrivent concaténés et le découpage naïf casse sur « Expires=Mon, 01… ».
  const bruts =
    typeof reponse.headers.getSetCookie === "function" ? reponse.headers.getSetCookie() : [];
  if (!bruts.length) return;
  const pot = potACookies.get(hote) || new Map();
  for (const brut of bruts) {
    const [paire] = String(brut).split(";");
    const i = paire.indexOf("=");
    if (i > 0) pot.set(paire.slice(0, i).trim(), paire.slice(i + 1).trim());
  }
  potACookies.set(hote, pot);
}

const cookiesPour = (hote) => {
  const pot = potACookies.get(hote);
  if (!pot || !pot.size) return null;
  return [...pot].map(([n, v]) => `${n}=${v}`).join("; ");
};

/* Vingt mégaoctets. Un `await reponse.text()` sur un corps dont on ne sait
   rien est un pari, et il a été perdu : la sonde s'est fait tuer par
   l'hébergeur — « Killed » — trois fois de suite, toujours au même
   marchand, sur un sitemap dont la taille n'était annoncée nulle part. On
   lit par morceaux et on renonce plutôt que d'emporter le processus qui
   sert le site. */
const MAX_OCTETS = 20 * 1024 * 1024;

/** Lit le corps sans dépasser la borne. Rend null si le contenu la franchit. */
async function lireBorne(reponse, maxOctets) {
  const annonce = parseInt(reponse.headers.get("content-length") || "", 10);
  if (Number.isFinite(annonce) && annonce > maxOctets) {
    await reponse.body?.cancel().catch(() => {});
    return null;
  }
  // Beaucoup de serveurs répondent en chunked, sans annoncer de taille :
  // c'est justement là que le pari se perd, il faut donc compter soi-même.
  if (!reponse.body) return reponse.text();
  const lecteur = reponse.body.getReader();
  const morceaux = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxOctets) {
      await lecteur.cancel().catch(() => {});
      return null;
    }
    morceaux.push(value);
  }
  return Buffer.concat(morceaux).toString("utf8");
}

/**
 * Récupère une page.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.ms] délai maximal
 * @param {string} [opts.referer] page d'où l'on vient — un navigateur en a
 *   presque toujours un, et son absence sur une fiche produit est notable.
 * @param {number} [opts.reprises] nombre de nouvelles tentatives sur 429/503.
 * @param {number} [opts.maxOctets] taille maximale du corps lu.
 * @returns {Promise<{code:number, texte:string, url:string, tropGros:boolean}>}
 */
async function demander(url, { ms, referer }) {
  const hote = hoteDe(url);

  // On ne rafale pas un domaine : ni pour passer inaperçu, ni pour le confort
  // du marchand qui nous laisse lire.
  if (hote) {
    const attente = PAUSE_PAR_HOTE - (Date.now() - (dernierPassage.get(hote) || 0));
    if (attente > 0) await dormir(attente);
    dernierPassage.set(hote, Date.now());
  }

  const entetes = { ...EN_TETES };
  if (referer) {
    entetes.Referer = referer;
    // Un navigateur qui suit un lien interne ne dit plus « je viens de nulle part ».
    entetes["Sec-Fetch-Site"] = "same-origin";
  }
  const biscuits = hote && cookiesPour(hote);
  if (biscuits) entetes.Cookie = biscuits;

  const reponse = await fetch(url, {
    headers: entetes,
    redirect: "follow",
    signal: AbortSignal.timeout(ms),
  });
  if (hote) lireCookies(reponse, hote);
  return reponse;
}

/**
 * Parcourt un document sans jamais le tenir entier en mémoire.
 *
 * Écrit pour les sitemaps d'Ikea : sept d'entre eux dépassent la borne de
 * vingt mégaoctets, et les refuser revenait à écarter un marchand entier
 * pour une limite qui est la nôtre, pas la sienne. On peut lire un fichier
 * de deux cents mégaoctets sans en garder plus d'un morceau à la fois — à
 * condition de traiter au vol au lieu d'accumuler.
 *
 * `surMorceau` reçoit chaque tranche décodée et rend `false` pour arrêter :
 * une fois les deux cents adresses trouvées, le reste du fichier ne nous
 * apprend plus rien et continuer serait du gaspillage des deux côtés.
 */
async function parcourir(url, { ms = 60000, referer = null, surMorceau } = {}) {
  const reponse = await demander(url, { ms, referer });
  if (!reponse.ok || !reponse.body) {
    await reponse.body?.cancel().catch(() => {});
    return { code: reponse.status, complet: false };
  }
  const lecteur = reponse.body.getReader();
  const decodeur = new TextDecoder("utf-8");
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    // `stream: true` : un caractère accentué peut être coupé entre deux
    // morceaux, et le décoder isolément produirait un losange noir.
    if (surMorceau(decodeur.decode(value, { stream: true })) === false) {
      await lecteur.cancel().catch(() => {});
      return { code: reponse.status, complet: false };
    }
  }
  return { code: reponse.status, complet: true };
}

async function recuperer(
  url,
  { ms = 30000, referer = null, reprises = 2, maxOctets = MAX_OCTETS } = {}
) {
  const reponse = await demander(url, { ms, referer });

  /* 429 et 503 ne sont pas des refus : ce sont des « pas si vite ». Les
     traiter comme un échec définitif nous faisait abandonner des marchands
     qui acceptaient simplement de nous servir plus lentement. */
  if ((reponse.status === 429 || reponse.status === 503) && reprises > 0) {
    const dit = parseInt(reponse.headers.get("retry-after") || "", 10);
    const patience = Number.isFinite(dit) ? Math.min(dit, 30) * 1000 : 5000;
    await dormir(patience);
    return recuperer(url, { ms, referer, reprises: reprises - 1 });
  }

  const corps = reponse.ok ? await lireBorne(reponse, maxOctets) : "";
  return {
    code: reponse.status,
    texte: corps === null ? "" : corps,
    url: reponse.url || url,
    tropGros: corps === null,
  };
}

/** Repart d'un état neuf — les tests ne doivent pas hériter des cookies du voisin. */
function oublier() {
  potACookies.clear();
  dernierPassage.clear();
}

module.exports = { recuperer, parcourir, oublier, EN_TETES, PAUSE_PAR_HOTE, MAX_OCTETS };
