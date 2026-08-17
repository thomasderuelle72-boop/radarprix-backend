// ranking.js — indicateur de classement pour les deals communautaires.
// Fonction pure (aucun accès DB) pour rester facilement testable :
// combine le score net de votes (pertinent / pas pertinent) avec un
// facteur de fraîcheur, façon "hot" Reddit/Hacker News simplifié.
//
// Principe : un deal très voté récemment doit sortir devant un deal
// ancien avec le même score net, mais un très gros écart de votes doit
// quand même pouvoir compenser l'ancienneté (sinon les nouveaux deals
// écrasent tout, même sans validation de la communauté).

/**
 * @param {number} upvotes - nombre de votes "pertinent"
 * @param {number} downvotes - nombre de votes "pas pertinent"
 * @param {string} createdAtSql - date SQLite ("YYYY-MM-DD HH:MM:SS", UTC, format datetime('now'))
 * @param {Date} [now] - instant de référence (par défaut : maintenant). Paramétrable pour les tests.
 * @returns {number} score : plus haut = mieux classé.
 */
function hotScore(upvotes, downvotes, createdAtSql, now = new Date()) {
  const net = (upvotes || 0) - (downvotes || 0);
  const order = Math.log10(Math.max(Math.abs(net), 1));
  const sign = net > 0 ? 1 : net < 0 ? -1 : 0;

  const createdMs = parseSqlDateUTC(createdAtSql);
  const ageHours = Math.max(0, (now.getTime() - createdMs) / (1000 * 60 * 60));

  // Décroissance douce : un deal perd l'équivalent d'un "ordre de grandeur"
  // de score tous les ~8 jours. À votes égaux, le plus récent reste devant ;
  // mais un deal massivement plus voté peut rester en tête bien plus longtemps.
  const decay = ageHours / 200;

  return sign * order - decay;
}

/** Parse une date SQLite ("YYYY-MM-DD HH:MM:SS", toujours UTC) en timestamp ms. */
function parseSqlDateUTC(sqlDate) {
  return new Date(sqlDate.replace(" ", "T") + "Z").getTime();
}

/** Trie une liste de deals (avec upvotes/downvotes/created_at) du mieux classé au moins bien classé. */
function sortByHotScore(deals, now = new Date()) {
  return [...deals].sort(
    (a, b) => hotScore(b.upvotes, b.downvotes, b.created_at, now) - hotScore(a.upvotes, a.downvotes, a.created_at, now)
  );
}

module.exports = { hotScore, sortByHotScore, parseSqlDateUTC };
