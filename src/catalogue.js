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

const { recuperer: naviguer } = require("./navigateur");

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

const adresses = (xml) => [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);

/* Un sitemap de fiches se reconnaît à son nom. On écarte explicitement les
   catalogues d'avis, de marques et de produits retirés : ils portent les
   mêmes mots mais ne mènent à aucun prix. */
const NOM_FICHES = /produit|product|fiche|catalog/i;
const NOM_INUTILE = /inactive|review|avis|brand|marque|categor|store|edito|conseil/i;

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

  const candidats = [...new Set([...declares, ...feuilles])]
    .filter((u) => NOM_FICHES.test(u) && !NOM_INUTILE.test(u));

  const fiches = new Set();
  for (const sm of (candidats.length ? candidats : feuilles).slice(0, 8)) {
    const s = await recuperer(sm, 60000);
    for (const u of adresses(s.texte)) {
      if (u.endsWith(".xml") || u.endsWith(".gz")) continue;
      if (autorise(u, interdits)) fiches.add(u);
    }
    /* Le plafond n'est pas un confort, c'est une condition de survie du
       processus. Boulanger en liste quatre-vingt mille, E.Leclerc et Rue du
       Commerce cent mille : la sonde qui les enchaînait s'est fait tuer par
       l'hébergeur au vingt-sixième marchand — « Killed », sans un mot de
       plus. Et de toute façon on n'en suit que huit cents. */
    if (fiches.size >= plafond) break;
  }
  if (!fiches.size) throw new Error("aucune fiche trouvée dans les sitemaps");
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

module.exports = {
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
