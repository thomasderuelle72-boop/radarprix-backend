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

const recuperer = async (url, ms = 30000) => {
  const r = await fetch(url, {
    headers: { "User-Agent": AGENT, Accept: "text/html,application/xml,*/*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(ms),
  });
  return { code: r.status, texte: r.ok ? await r.text() : "" };
};

const adresses = (xml) => [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);

/* Un sitemap de fiches se reconnaît à son nom. On écarte explicitement les
   catalogues d'avis, de marques et de produits retirés : ils portent les
   mêmes mots mais ne mènent à aucun prix. */
const NOM_FICHES = /produit|product|fiche|catalog/i;
const NOM_INUTILE = /inactive|review|avis|brand|marque|categor|store|edito|conseil/i;

/**
 * Découvre les fiches d'un marchand à partir de son robots.txt.
 *
 * Deux niveaux au plus : robots.txt donne des sitemaps, qui sont parfois
 * des index pointant vers les vrais fichiers. Au-delà, on s'égare dans des
 * arborescences qui ne mènent nulle part.
 */
async function decouvrirFiches(racine) {
  const rob = await recuperer(`${racine}/robots.txt`, 15000);
  if (!rob.texte) throw new Error(`robots.txt indisponible (HTTP ${rob.code})`);

  const declares = [...rob.texte.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  if (!declares.length) throw new Error("aucun sitemap déclaré dans robots.txt");

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
      if (!u.endsWith(".xml") && !u.endsWith(".gz")) fiches.add(u);
    }
    if (fiches.size > 60000) break; // au-delà, la mémoire ne sert à rien
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

module.exports = {
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
