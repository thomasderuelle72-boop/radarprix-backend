// moderation.js — Garde-fous sur tout ce qu'un membre peut publier
// (commentaires, messages du salon, sujets et réponses du forum, deals
// communautaires).
//
// Jusqu'ici il n'y en avait aucun : n'importe quel texte partait en base
// tel quel, sans limite de longueur au-delà du maxLength du formulaire
// (contournable trivialement en appelant l'API directement), sans
// anti-spam, et sans possibilité de signaler quoi que ce soit.
//
// Ce module ne prétend pas remplacer une modération humaine. Il bloque ce
// qui est objectivement abusif — texte vide, pavé de plusieurs pages, mur
// de liens, même message répété — et laisse passer le reste. Volontairement
// pas de liste de gros mots : trop de faux positifs sur des tournures
// légitimes, pour un bénéfice faible.

const LIMITES = {
  comment: { min: 2, max: 2000 },
  message: { min: 1, max: 2000 },
  thread: { min: 2, max: 5000 },
  reply: { min: 2, max: 5000 },
  title: { min: 3, max: 150 },
  dealTitle: { min: 3, max: 150 },
  dealDescription: { min: 0, max: 1000 },
};

/** Nombre de liens http(s) dans un texte. */
function compterLiens(texte) {
  return (texte.match(/https?:\/\/\S+/gi) || []).length;
}

/** Part de majuscules parmi les lettres — un texte TOUT EN MAJUSCULES crie. */
function partMajuscules(texte) {
  const lettres = texte.replace(/[^a-zA-ZÀ-ÿ]/g, "");
  if (lettres.length < 12) return 0; // trop court pour conclure ("OK", "LOL")
  const majuscules = lettres.replace(/[^A-ZÀ-Þ]/g, "").length;
  return majuscules / lettres.length;
}

/**
 * Valide un texte publié par un membre.
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
function validerTexte(texte, type = "comment") {
  const limites = LIMITES[type] || LIMITES.comment;
  const propre = String(texte ?? "").trim();

  if (propre.length < limites.min) {
    return { ok: false, error: "Ce champ est vide ou trop court." };
  }
  if (propre.length > limites.max) {
    return { ok: false, error: `Trop long : ${limites.max} caractères maximum.` };
  }
  // Un message quasi entièrement composé de liens est du spam dans la
  // quasi-totalité des cas ; un ou deux liens dans un vrai message, non.
  if (compterLiens(propre) > 3) {
    return { ok: false, error: "Trop de liens dans ce message." };
  }
  if (partMajuscules(propre) > 0.7) {
    return { ok: false, error: "Évite d'écrire tout en majuscules." };
  }
  // Même caractère répété en boucle ("aaaaaaaa…", "!!!!!!!!!!").
  if (/(.)\1{14,}/.test(propre)) {
    return { ok: false, error: "Ce message contient trop de caractères répétés." };
  }

  return { ok: true, value: propre };
}

/**
 * Limitation de fréquence en mémoire, par membre et par action.
 *
 * En mémoire volontairement : le service tourne en un seul processus (voir
 * server.js), et perdre ces compteurs à chaque redémarrage est sans
 * conséquence. Une table SQLite ajouterait des écritures permanentes pour
 * un gain nul à cette échelle.
 */
const historique = new Map(); // "userId:action" -> [timestamps]

function limiterFrequence(userId, action, maxParFenetre = 5, fenetreMs = 60000) {
  const cle = `${userId}:${action}`;
  const maintenant = Date.now();
  const recents = (historique.get(cle) || []).filter((t) => maintenant - t < fenetreMs);

  if (recents.length >= maxParFenetre) {
    const attente = Math.ceil((fenetreMs - (maintenant - recents[0])) / 1000);
    return { ok: false, error: `Tu publies trop vite — réessaie dans ${attente} seconde(s).` };
  }

  recents.push(maintenant);
  historique.set(cle, recents);

  // Purge occasionnelle : sans ça, la Map grossirait indéfiniment avec les
  // membres inactifs.
  if (historique.size > 5000) {
    for (const [k, v] of historique) {
      if (v.every((t) => maintenant - t > fenetreMs)) historique.delete(k);
    }
  }

  return { ok: true };
}

/** Deux publications identiques d'affilée par le même membre = doublon. */
const dernierTexte = new Map(); // userId -> dernier texte publié

function refuserDoublon(userId, texte) {
  const precedent = dernierTexte.get(userId);
  if (precedent && precedent === texte) {
    return { ok: false, error: "Tu viens déjà de publier ce message." };
  }
  dernierTexte.set(userId, texte);
  return { ok: true };
}

module.exports = { validerTexte, limiterFrequence, refuserDoublon, LIMITES };
