// badges.js — Distinctions obtenues par un membre au fil de sa participation.
//
// Rien n'est stocké en base : un badge se déduit entièrement de ce que le
// membre a déjà fait. C'est volontaire — une table de badges devrait être
// tenue à jour par un traitement de fond, pourrait se désynchroniser des
// données réelles, et il faudrait la reconstruire à chaque changement de
// barème. Ici, changer un palier suffit, et les badges de tout le monde
// sont recalculés correctement à la lecture suivante.
//
// Le principe est le même pour toutes les familles : on reçoit la liste
// horodatée des évènements qui la font progresser (voir badgeEventDates
// dans db.js), et le niveau atteint est le nombre de paliers franchis. La
// date d'obtention n'est pas inventée : c'est celle de l'évènement qui a
// fait franchir le palier.

const FAMILLES = [
  {
    cle: "chasseur",
    nom: "Chasseur",
    icone: "radar",
    source: "deals",
    paliers: [1, 5, 25, 100],
    texte: (n) =>
      n === 1
        ? "Vous avez partagé votre premier bon plan avec la communauté. C'est comme ça que tout commence."
        : `Vous avez partagé ${n} bons plans. La communauté compte sur vous pour dénicher les bonnes affaires.`,
  },
  {
    cle: "eclaireur",
    nom: "Éclaireur",
    icone: "search",
    source: "votes",
    paliers: [1, 10, 50, 200],
    texte: (n) =>
      n === 1
        ? "Vous avez donné votre premier avis sur un deal. Vos votes aident les autres à faire le tri."
        : `Vous avez voté ${n} fois. Vos votes mettent en avant les vraies bonnes affaires et enterrent les autres.`,
  },
  {
    cle: "voix",
    nom: "Voix de la communauté",
    icone: "message",
    source: "commentaires",
    paliers: [1, 25, 100, 500],
    texte: (n) =>
      n === 1
        ? "Vous avez laissé votre premier commentaire sous un deal."
        : `Vous avez écrit ${n} commentaires. Un retour d'expérience vaut souvent mieux qu'un prix barré.`,
  },
  {
    cle: "animateur",
    nom: "Animateur",
    icone: "users",
    source: "forum",
    paliers: [1, 10, 50],
    texte: (n) =>
      n === 1
        ? "Vous avez pris la parole sur le forum pour la première fois."
        : `Vous avez participé ${n} fois aux discussions du forum.`,
  },
  {
    cle: "populaire",
    nom: "Flair reconnu",
    icone: "flame",
    source: "votesRecus",
    paliers: [10, 100, 1000],
    texte: (n) => `Vos deals ont récolté ${n} votes positifs. Vos trouvailles font mouche.`,
  },
  {
    cle: "pilier",
    nom: "Pilier",
    icone: "shield",
    source: "anciennete",
    paliers: [1, 2, 3], // 1 mois, 6 mois, 1 an — voir datesAnciennete()
    texte: (n) => ["Membre depuis un mois.", "Membre depuis six mois.", "Membre depuis un an."][n - 1],
  },
];

/** Ajoute un nombre de mois à une date SQLite, en renvoyant le même format. */
function plusMois(dateSql, mois) {
  const d = new Date(String(dateSql).replace(" ", "T") + "Z");
  d.setUTCMonth(d.getUTCMonth() + mois);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * L'ancienneté n'a pas d'évènement en base : les "évènements" sont les
 * anniversaires déjà passés. On ne garde que ceux-là — un badge ne peut pas
 * être daté dans le futur.
 */
function datesAnciennete(inscription, maintenant = new Date()) {
  if (!inscription) return [];
  return [1, 6, 12]
    .map((mois) => plusMois(inscription, mois))
    .filter((date) => new Date(date.replace(" ", "T") + "Z") <= maintenant);
}

/**
 * Calcule les badges d'un membre.
 * @param {object} evenements - sortie de badgeEventDates() (db.js)
 * @returns {Array} badges obtenus, du plus récent au plus ancien, chacun
 *   accompagné du prochain palier à atteindre quand il en reste un.
 */
function calculerBadges(evenements, maintenant = new Date()) {
  const sources = { ...evenements, anciennete: datesAnciennete(evenements.inscription, maintenant) };
  const obtenus = [];

  for (const famille of FAMILLES) {
    const dates = sources[famille.source] || [];
    for (let i = 0; i < famille.paliers.length; i++) {
      const palier = famille.paliers[i];
      if (dates.length < palier) break;
      obtenus.push({
        cle: `${famille.cle}-${i + 1}`,
        famille: famille.cle,
        nom: famille.nom,
        niveau: i + 1,
        icone: famille.icone,
        // Le palier est atteint par le Nième évènement, donc à sa date.
        obtenuLe: dates[palier - 1],
        description: famille.texte(palier),
      });
    }
  }

  return obtenus.sort((a, b) => String(b.obtenuLe).localeCompare(String(a.obtenuLe)));
}

/**
 * Progression vers les prochains badges — ce qu'il reste à faire. Utile pour
 * donner un cap à un nouveau membre plutôt qu'un profil vide.
 */
function prochainsBadges(evenements, maintenant = new Date()) {
  const sources = { ...evenements, anciennete: datesAnciennete(evenements.inscription, maintenant) };
  const suite = [];

  for (const famille of FAMILLES) {
    if (famille.source === "anciennete") continue; // rien à "faire" : il faut attendre
    const acquis = (sources[famille.source] || []).length;
    const palier = famille.paliers.find((p) => acquis < p);
    if (palier === undefined) continue;
    suite.push({
      famille: famille.cle,
      nom: famille.nom,
      icone: famille.icone,
      niveau: famille.paliers.indexOf(palier) + 1,
      actuel: acquis,
      objectif: palier,
      description: famille.texte(palier),
    });
  }

  // Le plus proche d'abord : c'est celui qui donne envie de continuer.
  return suite.sort((a, b) => a.objectif - a.actuel - (b.objectif - b.actuel));
}

module.exports = { calculerBadges, prochainsBadges, datesAnciennete, FAMILLES };
