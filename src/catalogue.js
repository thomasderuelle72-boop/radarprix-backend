// catalogue.js — Suivre le catalogue d'un marchand, par son propre sitemap.
//
// POURQUOI CE CANAL EXISTE
//
// C'est la seule voie vers de vraies erreurs de prix qui soient les nôtres.
// Un agrégateur nous dit ce que d'autres ont trouvé ; un flux d'affiliation
// nous dit ce que le marchand veut promouvoir. Ni l'un ni l'autre ne repère
// le prix qui vient de tomber de 900 € à 90 € pendant vingt minutes.
//
// Pour le voir, il faut avoir relevé le prix d'hier. D'où ce canal :
//
//   1. le marchand publie son catalogue dans son sitemap, qu'il déclare
//      lui-même dans robots.txt — donc il veut être parcouru ;
//   2. il balise ses fiches en schema.org, pour Google ;
//   3. on en relève une tranche à chaque passage, et le prix entre en
//      historique (table snapshots) ;
//   4. algorithm.js compare ce prix à celui d'hier et à celui des autres
//      vendeurs du même produit. L'anomalie sort de LA mesure, pas d'une
//      déclaration.
//
// CE QUI A ÉTÉ MESURÉ, LE 23 AOÛT 2026
//
// Sur quatre-vingt-quatre enseignes, la plupart refusent tout robot (403
// Cloudflare, DataDome) ou n'exposent aucun sitemap. Celles-ci répondent et
// balisent leurs fiches :
//
//   LDLC          50 000 fiches   6/6 lues
//   JouéClub      40 001 fiches   4/4
//   Electro Dépôt  2 915 fiches   4/4
//   Ikea           4 526 fiches   4/4
//   N&D              107 fiches   4/4
//
// La rotation est le point délicat : relever cinquante mille fiches à
// chaque passage serait aussi inutile qu'agressif. On en prend une tranche,
// la plus anciennement vue d'abord, et le tour complet se fait en plusieurs
// jours.

const { db } = require("./db");

const { recuperer: naviguer, parcourir: naviguerEnFlux } = require("./navigateur");

const AGENT = "Mozilla/5.0 (compatible; RadarPrix/1.0; +https://radarprix.fr)";

db.exec(`
  -- Les fiches connues d'un marchand, et la date du dernier relevé. C'est
  -- cette date qui fait tourner la rotation : on reprend toujours par les
  -- plus anciennes.
  CREATE TABLE IF NOT EXISTS catalogue_fiches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cible INTEGER NOT NULL,
    url TEXT NOT NULL,
    dernier_releve TEXT,
    echecs INTEGER NOT NULL DEFAULT 0,
    ajoutee_le TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(cible, url)
  );
  CREATE INDEX IF NOT EXISTS idx_fiches_rotation ON catalogue_fiches(cible, dernier_releve);
`);

/* La récupération passe désormais par navigateur.js : jeu d'en-têtes
   complet, pot à cookies, pause par hôte, patience sur 429/503. L'ancien
   `fetch` nu portait un seul en-tête, ce qui est en soi un signal. La
   signature reste la même — collect.js l'importe d'ici. */
const recuperer = (url, ms = 30000, opts = {}) => naviguer(url, { ms, ...opts });

/* Le `max` n'est pas une commodité : sans lui, matchAll matérialise d'un
   coup le tableau de TOUTES les correspondances d'un sitemap qui pèse
   plusieurs dizaines de mégaoctets. C'est ce qui a fait tuer la sonde par
   l'hébergeur, trois fois, exactement au même marchand. */
const adresses = (xml, max = Infinity) => {
  const trouvees = [];
  const motif = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let m;
  while (trouvees.length < max && (m = motif.exec(String(xml))) !== null) trouvees.push(m[1]);
  return trouvees;
};

/* Un sitemap de fiches se reconnaît à son nom. On écarte explicitement les
   catalogues d'avis, de marques et de produits retirés : ils portent les
   mêmes mots mais ne mènent à aucun prix. */
const NOM_FICHES = /produit|product|fiche|catalog/i;
const NOM_INUTILE = /inactive|review|avis|brand|marque|categor|store|edito|conseil/i;

/* Ce qu'une adresse ne doit PAS être pour qu'on la relève.
 *
 * Mesuré le 24 août 2026 en inspectant les fiches réellement suivies : on
 * ne relevait pas des fiches produits du tout. Ikea nous donnait des pages
 * de catégorie bahreïniennes en arabe, Vinted des catégories, Marionnaud
 * ses propres endpoints de sitemap, Midas sa page d'accueil. extraction.js
 * ne trouvait aucun prix pour une raison simple : il n'y avait aucun
 * produit à lire.
 *
 * Le filtre existant ne portait que sur le NOM du fichier sitemap, jamais
 * sur les adresses qu'il contient. */
const CHEMIN_INUTILE =
  /\/(?:api|sitemaps?|cat|catalog|catalogue|categorie|categories|rayon|rayons|contenu|content|blog|aide|help|service|services|magasin|magasins|store-locator|recherche|search|panier|compte|account|cgv|mentions)(?:\/|$)/i;

/* Ce qui ressemble à une fiche. Volontairement large : chaque marchand a sa
   convention, et se tromper par excès coûte une fiche illisible, tandis que
   se tromper par défaut coûte le marchand entier. */
const CHEMIN_FICHE = /\/(?:p|v|produit|produits|product|products|fiche|dp|item)\/|-\d{6,}\.html?$|\/pd\//i;

/**
 * Cette adresse peut-elle être une fiche produit française ?
 *
 * Deux refus, et le second n'est pas théorique : le sitemap mondial d'Ikea
 * nous a fait relever des woks bahreïniens libellés en arabe. Un préfixe de
 * pays qui n'est pas le nôtre ne mène jamais à un prix en euros.
 */
function ficheProbable(url) {
  let chemin;
  try {
    chemin = new URL(url).pathname;
  } catch {
    return false;
  }
  if (CHEMIN_INUTILE.test(chemin)) return false;
  // « /bh/ar/… » : un code pays de deux lettres en tête, et ce n'est pas la
  // France. Les segments de langue seuls (« /fr/ ») restent acceptés.
  const pays = chemin.match(/^\/([a-z]{2})\/([a-z]{2})\//i);
  if (pays && pays[1].toLowerCase() !== "fr") return false;
  return true;
}

/**
 * Les chemins que robots.txt interdit à tout le monde.
 *
 * On ne lit que le bloc « User-agent: * » : un marchand qui nous nommerait
 * expressément n'existe pas, et se glisser dans les règles écrites pour
 * Googlebot serait précisément se faire passer pour un autre.
 */
function cheminsInterdits(robots) {
  const interdits = [];
  let concerne = false;
  for (const ligne of String(robots).split(/\r?\n/)) {
    const propre = ligne.replace(/#.*$/, "").trim();
    if (!propre) continue;
    const [cle, ...reste] = propre.split(":");
    const valeur = reste.join(":").trim();
    const nom = cle.trim().toLowerCase();
    if (nom === "user-agent") concerne = valeur === "*";
    else if (concerne && nom === "disallow" && valeur) interdits.push(valeur);
  }
  return interdits;
}

/** Une adresse est-elle hors des chemins interdits ? */
function autorise(url, interdits) {
  if (!interdits.length) return true;
  let chemin;
  try {
    chemin = new URL(url).pathname;
  } catch {
    return false;
  }
  // Le préfixe fait foi, comme le veut la norme ; « * » et « $ » restent
  // ignorés — les gérer demanderait un vrai analyseur, et aucun marchand du
  // registre ne s'en sert pour interdire ses fiches produits.
  return !interdits.some((i) => chemin.startsWith(i));
}

/**
 * Découvre les fiches d'un marchand à partir de son robots.txt.
 *
 * Deux niveaux au plus : robots.txt donne des sitemaps, qui sont parfois
 * des index pointant vers les vrais fichiers. Au-delà, on s'égare dans des
 * arborescences qui ne mènent nulle part.
 */
async function decouvrirFiches(racine, { plafond = 60000 } = {}) {
  const rob = await recuperer(`${racine}/robots.txt`, 15000);
  if (!rob.texte) throw new Error(`robots.txt indisponible (HTTP ${rob.code})`);

  const declares = [...rob.texte.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  if (!declares.length) throw new Error("aucun sitemap déclaré dans robots.txt");

  /* On lisait la liste des sitemaps dans robots.txt sans jamais lire ses
     interdictions — prendre ce qu'un fichier offre en ignorant ce qu'il
     refuse. Les chemins interdits sont désormais écartés. */
  const interdits = cheminsInterdits(rob.texte);

  const feuilles = [];
  for (const sm of declares.slice(0, 10)) {
    const s = await recuperer(sm, 40000);
    const l = adresses(s.texte);
    if (!l.length) continue;
    if (l[0].endsWith(".xml")) feuilles.push(...l);
    else feuilles.push(sm);
  }

  let candidats = [...new Set([...declares, ...feuilles])]
    .filter((u) => NOM_FICHES.test(u) && !NOM_INUTILE.test(u));

  /* Quand des sitemaps se réclament de la France, on ne lit que ceux-là.
     Ikea publie un index mondial : nos huit lectures partaient dans les
     catalogues étrangers — Bahreïn en tête, par ordre alphabétique — et il
     ne restait plus de budget pour le catalogue français. On ne relevait pas
     un seul produit d'un marchand parfaitement lisible. */
  const francais = candidats.filter((u) => /(?:^|[/_.-])fr(?:[/_.-]|$)|france/i.test(u));
  if (francais.length) candidats = francais;

  const fiches = new Set();
  let ecartes = 0;
  const retenir = (u) =>
    !u.endsWith(".xml") && !u.endsWith(".gz") && ficheProbable(u) && autorise(u, interdits);

  for (const sm of (candidats.length ? candidats : feuilles).slice(0, 8)) {
    try {
      /* Lu au fil de l'eau. Sept sitemaps d'Ikea dépassaient la borne de
         vingt mégaoctets, et les refuser revenait à écarter un marchand
         entier pour une limite qui est la nôtre, pas la sienne.

         Le plafond, lui, reste une condition de survie du processus :
         Boulanger liste quatre-vingt mille adresses, E.Leclerc et Rue du
         Commerce cent mille, et la sonde qui les enchaînait s'est fait tuer
         par l'hébergeur — « Killed », sans un mot de plus. On s'arrête donc
         dès qu'il y a de quoi remplir la rotation. */
      for (const u of await adressesEnFlux(sm, plafond, retenir)) fiches.add(u);
    } catch {
      ecartes++;
    }
    if (fiches.size >= plafond) break;
  }
  /* Quand une partie des adresses porte une marque de fiche, on ne garde
     QUE celles-là. Règle qui se règle toute seule : un marchand qui mélange
     « /p/xxx » et « /conseils/xxx » se voit ramené à ses produits sans
     qu'on ait rien à écrire pour lui en particulier. */
  const marquees = [...fiches].filter((u) => CHEMIN_FICHE.test(u));
  if (marquees.length >= 10) return marquees;

  if (!fiches.size) {
    throw new Error(
      ecartes
        ? `${ecartes} sitemap(s) illisibles`
        : "aucune fiche trouvée dans les sitemaps"
    );
  }
  return [...fiches];
}

/* Combien de fiches on suit par marchand — et c'est l'arithmétique qui
   décide, pas l'envie d'en avoir beaucoup.

   Un passage relève soixante fiches, le cron passe huit fois par jour :
   quatre cent quatre-vingts relevés quotidiens par marchand. Suivre les
   soixante-dix-huit mille fiches de LDLC ferait revenir sur chacune tous
   les cent soixante-quatre jours — autant ne rien mesurer.
   
   À huit cents fiches suivies, on repasse sur chacune toutes les quarante
   heures. C'est ce qu'il faut pour voir un prix décrocher et le dire.
   
   À dire franchement : ça repère une baisse qui dure, pas une erreur de
   prix de vingt minutes. Celle-là demanderait de surveiller quelques
   dizaines de produits en permanence — un autre réglage du même mécanisme,
   qu'on pourra ajouter quand on saura QUELS produits surveiller. */
const FICHES_SUIVIES = 800;

/**
 * Échantillon stable d'un catalogue.
 *
 * Le tirage doit être déterministe : au prochain passage, on veut retrouver
 * LES MÊMES fiches, sinon l'historique de prix ne se constitue jamais et
 * aucune anomalie n'est mesurable. On prend donc un pas régulier dans la
 * liste plutôt qu'un tirage aléatoire.
 */
function echantillon(urls, taille) {
  if (urls.length <= taille) return urls;
  const pas = urls.length / taille;
  return Array.from({ length: taille }, (_, i) => urls[Math.floor(i * pas)]);
}

/** Enregistre les fiches découvertes. Les connues gardent leur historique. */
function enregistrerFiches(cibleId, urls, taille = FICHES_SUIVIES) {
  const ins = db.prepare("INSERT OR IGNORE INTO catalogue_fiches (cible, url) VALUES (?, ?)");
  const lot = db.transaction((liste) => { for (const u of liste) ins.run(cibleId, u); });
  const avant = compterFiches(cibleId);
  lot(echantillon(urls, taille));
  return compterFiches(cibleId) - avant;
}

const compterFiches = (cibleId) =>
  db.prepare("SELECT COUNT(*) AS n FROM catalogue_fiches WHERE cible = ?").get(cibleId).n;

/**
 * La tranche à relever maintenant : les plus anciennement vues d'abord.
 *
 * Les fiches qui ont échoué trois fois sont écartées — produit retiré, page
 * déplacée. Sans ce garde-fou, une part croissante de chaque passage se
 * dépenserait sur des adresses mortes.
 */
function prochainesFiches(cibleId, taille) {
  return db
    .prepare(
      `SELECT id, url FROM catalogue_fiches
       WHERE cible = ? AND echecs < 3
       ORDER BY dernier_releve IS NOT NULL, dernier_releve ASC
       LIMIT ?`
    )
    .all(cibleId, taille);
}

const marquerRelevee = (id) =>
  db.prepare("UPDATE catalogue_fiches SET dernier_releve = datetime('now'), echecs = 0 WHERE id = ?").run(id);

const marquerEchec = (id) =>
  db.prepare("UPDATE catalogue_fiches SET dernier_releve = datetime('now'), echecs = echecs + 1 WHERE id = ?").run(id);

/** État de la rotation, pour le tableau de bord. */
function etatCatalogue(cibleId) {
  const l = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN dernier_releve IS NULL THEN 1 ELSE 0 END) AS jamais,
              SUM(CASE WHEN echecs >= 3 THEN 1 ELSE 0 END) AS abandonnees,
              MIN(dernier_releve) AS plus_ancien
       FROM catalogue_fiches WHERE cible = ?`
    )
    .get(cibleId);
  return { total: l.total, jamais: l.jamais || 0, abandonnees: l.abandonnees || 0, plusAncien: l.plus_ancien };
}

/**
 * Les adresses d'un sitemap, lues au fil de l'eau.
 *
 * En traitant chaque morceau au vol, la taille du fichier cesse d'être un
 * problème : on n'en garde jamais plus d'une tranche, et on s'arrête dès
 * qu'on a de quoi remplir la rotation — le reste du fichier ne nous
 * apprendrait rien et le télécharger serait du gaspillage des deux côtés.
 *
 * Le report entre morceaux n'est pas un détail : une balise <loc> coupée en
 * deux par le découpage réseau serait perdue sans lui, et rien ne le
 * signalerait — on croirait simplement le sitemap plus pauvre qu'il n'est.
 */
async function adressesEnFlux(url, plafond, garder) {
  const trouvees = [];
  let report = "";
  await naviguerEnFlux(url, {
    ms: 90000,
    surMorceau: (morceau) => {
      const texte = report + morceau;
      let dernier = 0;
      for (const m of texte.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
        dernier = m.index + m[0].length;
        if (garder(m[1])) trouvees.push(m[1]);
        if (trouvees.length >= plafond) return false;
      }
      report = texte.slice(Math.max(dernier, texte.length - 2000));
      return true;
    },
  });
  return trouvees;
}

/**
 * Retire les adresses déjà listées qui ne sont pas des fiches produits.
 *
 * Le filtre corrige la découverte à venir, mais des milliers de catégories,
 * d'endpoints d'API et de pages d'accueil sont déjà en base et la rotation
 * continuerait de les interroger — soixante requêtes par passage, huit fois
 * par jour, pour des pages qui ne portent aucun prix.
 *
 * Une fois vidée, la cible repasse sous le seuil de redécouverte et se
 * reconstitue toute seule au prochain scan.
 */
function purgerFichesNonProduits() {
  const lignes = db.prepare("SELECT id, url FROM catalogue_fiches").all();
  const aRetirer = lignes.filter((l) => !ficheProbable(l.url)).map((l) => l.id);
  if (!aRetirer.length) return { retirees: 0, restantes: lignes.length };

  const suppression = db.prepare("DELETE FROM catalogue_fiches WHERE id = ?");
  db.transaction((ids) => ids.forEach((id) => suppression.run(id)))(aRetirer);
  return { retirees: aRetirer.length, restantes: lignes.length - aRetirer.length };
}

/**
 * Qui, dans le registre, se laisse encore lire ?
 *
 * Le relevé qui fonde toute la stratégie d'acquisition — « cinq marchands
 * sur quatre-vingt-quatre » — date du 22 août et le registre en compte
 * maintenant cent vingt-deux. Surtout, il a été fait depuis un
 * environnement dont on ne sait plus s'il avait la même sortie réseau que
 * la production : mesuré depuis un bac à sable, LDLC, JouéClub et Electro
 * Dépôt rendent tous 403 alors qu'ils alimentent le site tous les jours.
 * Une mesure d'accès ne vaut donc que faite depuis l'IP qui collecte.
 *
 * La sonde refait le chemin complet, marchand par marchand : robots.txt →
 * sitemaps → quelques fiches → un prix. Elle ne publie rien et n'écrit rien
 * en base ; elle répond à une question, et cette question reviendra chaque
 * fois qu'un marchand changera son site.
 *
 * @param {object} [opts]
 * @param {number} [opts.fiches] fiches lues par marchand pour juger
 * @param {(r:object)=>void} [opts.surChaque] appelé après chaque marchand,
 *   pour que l'appelant journalise au fil de l'eau plutôt qu'à la fin —
 *   quatre-vingt-quatre marchands prennent de longues minutes.
 * @param {number} [opts.budgetMs] temps maximal accordé à un marchand.
 *   Sans lui, `decouvrirFiches` peut en retenir un quart d'heure : dix
 *   sitemaps à quarante secondes puis huit à soixante. La première sonde a
 *   calé huit minutes sur Recommerce et n'a jamais vu les cinquante-sept
 *   marchands suivants. Une mesure qui ne finit pas ne mesure rien.
 */
async function sonderMarchands({ fiches = 3, surChaque = null, budgetMs = 90000 } = {}) {
  const avecBudget = (promesse, ms) =>
    Promise.race([
      promesse,
      new Promise((_, rejeter) =>
        setTimeout(() => rejeter(new Error(`abandon après ${Math.round(ms / 1000)} s`)), ms)
      ),
    ]);
  const { MARCHANDS } = require("./marchands");
  const { produitDepuisHtml } = require("./extraction");
  const resultats = [];

  for (const m of MARCHANDS) {
    // Une marque n'est pas une enseigne : elle n'a pas de catalogue à suivre.
    if (m.marque) continue;
    const racine = `https://www.${m.domaine}`;
    const ligne = { nom: m.nom, domaine: m.domaine, fiches: 0, lues: 0, essais: 0, erreur: null };

    try {
      /* La sonde répond à « sait-on lire ce marchand ? », pas à « combien
         a-t-il de fiches ». Deux cents suffisent à en tirer trois, et ne
         pas en garder cent mille est ce qui lui permet d'aller au bout des
         quatre-vingt-quatre. */
      const urls = await avecBudget(decouvrirFiches(racine, { plafond: 200 }), budgetMs);
      ligne.fiches = urls.length;
      // Un pas régulier plutôt que la tête de liste : le début d'un sitemap
      // est souvent une poignée de pages éditoriales sans prix.
      for (const u of echantillon(urls, fiches)) {
        ligne.essais++;
        try {
          const page = await recuperer(u, 15000);
          const p = page.texte ? produitDepuisHtml(page.texte) : null;
          if (p && Number.isFinite(p.prix)) ligne.lues++;
        } catch {
          /* une fiche muette ne condamne pas le marchand */
        }
      }
    } catch (e) {
      ligne.erreur = e.message;
    }

    resultats.push(ligne);
    if (surChaque) surChaque(ligne);
  }
  return resultats;
}

/**
 * Que contient vraiment cette page ?
 *
 * Écrit après avoir deviné deux fois de suite. Onze marchands listent leurs
 * fiches et servent leurs pages, et trois stratégies d'extraction — balisage
 * schema.org, microdata, OpenGraph — n'y trouvent rien. J'ai supposé que
 * leur produit dormait dans un `<script type="application/json">` : mesuré,
 * non. Supposer une quatrième fois coûterait un déploiement de plus pour
 * rien.
 *
 * L'inspecteur ne cherche pas un prix : il dit ce qu'il y a. Taille, codes,
 * types de scripts présents, marqueurs des cadres applicatifs connus, et
 * si le caractère « € » apparaît seulement quelque part. Avec ça on saura
 * quoi écrire, au lieu de le deviner.
 */
async function inspecterPage(url, { extrait = 240 } = {}) {
  const page = await recuperer(url, 20000);
  const html = page.texte || "";
  const visible = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const marqueur = (motif) => motif.test(html);
  const euros = [...visible.matchAll(/(\d[\d\s\u00a0.]*,\d{2})\s*€/g)].map((m) => m[1]).slice(0, 6);

  return {
    url,
    code: page.code,
    octets: html.length,
    tropGros: Boolean(page.tropGros),
    // Ce que le visiteur voit — s'il n'y a aucun « € », la page est une
    // coquille remplie après coup par le navigateur, et aucune lecture du
    // HTML ne la sauvera.
    euroVisible: visible.includes("€"),
    prixVus: euros,
    debutTexte: visible.slice(0, extrait),
    // Les sitemaps déclarés : c'est par eux que passe toute la découverte,
    // et les voir évite de deviner ce qu'un marchand publie.
    sitemaps: [...String(html).matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]).slice(0, 40),
    // Les types de <script> présents, dédupliqués : c'est là que se rangent
    // les états applicatifs.
    typesScript: [
      ...new Set(
        [...html.matchAll(/<script[^>]*type=["']([^"']+)["']/gi)].map((m) => m[1].toLowerCase())
      ),
    ].slice(0, 12),
    cadres: {
      nextData: marqueur(/__NEXT_DATA__/),
      nextFlux: marqueur(/self\.__next_f/),
      nuxt: marqueur(/window\.__NUXT__/),
      etatInitial: marqueur(/__INITIAL_STATE__|__PRELOADED_STATE__|__APOLLO_STATE__/),
      jsonLd: marqueur(/application\/ld\+json/i),
      microdata: marqueur(/itemprop=["']price["']/i),
      ogPrice: marqueur(/og:price:amount|product:price:amount/i),
      dataPrix: marqueur(/data-(?:price|prix|product-price)=/i),
      angular: marqueur(/ng-version=/i),
    },
  };
}

/**
 * Inspecte une fiche RÉELLE d'un marchand déjà suivi.
 *
 * Les pages d'accueil ont menti par omission : celle d'Ikea porte du
 * JSON-LD et des prix, celle d'Aldi n'affiche aucun euro. Ni l'une ni
 * l'autre ne dit ce que fait une FICHE PRODUIT, qui est la seule chose
 * qu'on relève. On tire donc une adresse de celles que la rotation suit
 * déjà.
 */
async function inspecterMarchand(nom) {
  const cible = db
    .prepare("SELECT id, merchant FROM watch_targets WHERE merchant = ? AND catalogue_url IS NOT NULL")
    .get(nom);
  if (!cible) return { erreur: `aucune cible catalogue pour « ${nom} »` };

  const fiches = db
    .prepare("SELECT url FROM catalogue_fiches WHERE cible = ? ORDER BY id LIMIT 3")
    .all(cible.id);
  if (!fiches.length) return { erreur: `« ${nom} » n'a encore aucune fiche listée` };

  const releves = [];
  for (const f of fiches) releves.push(await inspecterPage(f.url));
  return { marchand: nom, fiches: releves };
}

module.exports = {
  ficheProbable,
  purgerFichesNonProduits,
  inspecterMarchand,
  inspecterPage,
  sonderMarchands,
  cheminsInterdits,
  autorise,
  FICHES_SUIVIES,
  echantillon,
  decouvrirFiches,
  enregistrerFiches,
  prochainesFiches,
  marquerRelevee,
  marquerEchec,
  compterFiches,
  etatCatalogue,
  recuperer,
  AGENT,
};
