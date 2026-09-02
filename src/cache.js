// cache.js — Mémoire courte devant les lectures publiques.
//
// POURQUOI
//
// `better-sqlite3` est synchrone : chaque requête bloque le thread qui sert
// TOUS les visiteurs. C'est le plafond de charge du site, nommé comme tel
// dans CLAUDE.md. Le flux public est de très loin la lecture la plus
// fréquente, et la plus répétitive : dix visiteurs sur la page d'accueil à
// la même seconde posent dix fois exactement la même question.
//
// Un cache en mémoire de quelques secondes suffit donc à transformer dix
// requêtes bloquantes en une. Ce n'est pas Redis, et ça n'a pas à l'être :
// le site tourne en un seul processus sur Railway, et une dépendance
// externe pour tenir dix requêtes par seconde serait un coût sans contrepartie.
//
// CE QU'IL FAUT SAVOIR AVANT DE PASSER À L'ÉCHELLE
//
// Le jour où le site tourne sur plusieurs instances, ce cache devient un
// cache PAR INSTANCE : deux visiteurs peuvent voir deux états différents
// pendant la durée du TTL. C'est acceptable pour un flux de bons plans
// (quelques secondes de retard), et ça ne le serait pas pour un panier ou
// un solde. La bascule vers Redis se fait alors ici, derrière la même
// fonction `memo()`, sans toucher aux routes.
//
// INVALIDATION
//
// Par génération, pas par clé. Publier un deal incrémente un compteur, et
// toutes les clés de l'ancienne génération deviennent inatteignables — donc
// mortes. Parcourir la Map pour supprimer les entrées concernées coûterait
// plus cher que de les laisser expirer, et invalider par motif de clé est
// la source classique de caches qui servent du périmé.

/* Le TTL. Cinq secondes est le point où le cache absorbe une rafale sans
   qu'un visiteur puisse remarquer le retard : un bon plan publié se voit au
   rechargement suivant. */
const TTL_DEFAUT = 5000;

/* Plafond d'entrées. Sans lui, une API paginée et filtrable fabrique une clé
   par combinaison possible, et le cache devient une fuite de mémoire lente. */
const MAX_ENTREES = 500;

const entrees = new Map();
let generation = 1;

/** Invalide tout le cache. Appelé quand les données servies changent. */
function invalider() {
  generation += 1;
  entrees.clear();
  return generation;
}

/**
 * Rend la valeur mémorisée pour `cle`, ou la calcule.
 *
 * `calcul` est synchrone à dessein : tout ce qu'on mémorise ici vient de
 * SQLite, qui l'est aussi. Mémoriser une promesse ouvrirait la question du
 * cache d'une erreur, qu'on n'a pas besoin de se poser.
 */
function memo(cle, calcul, ttl = TTL_DEFAUT) {
  const k = `${generation}:${cle}`;
  const maintenant = Date.now();
  const trouve = entrees.get(k);
  if (trouve && trouve.expire > maintenant) return trouve.valeur;

  const valeur = calcul();

  /* Éviction avant insertion, et par ordre d'insertion : une Map JavaScript
     conserve cet ordre, donc la première clé est la plus ancienne. Ce n'est
     pas un LRU — c'est un FIFO — et c'est suffisant pour un cache dont
     toutes les entrées expirent en quelques secondes. */
  if (entrees.size >= MAX_ENTREES) {
    const plusAncienne = entrees.keys().next().value;
    entrees.delete(plusAncienne);
  }
  entrees.set(k, { valeur, expire: maintenant + ttl });
  return valeur;
}

/**
 * Étiquette d'une réponse : un condensé court et stable de son contenu.
 *
 * Sert l'ETag HTTP. Un navigateur qui repasse avec `If-None-Match` reçoit un
 * 304 sans corps — ce qui économise la bande passante ET la sérialisation
 * JSON, souvent plus coûteuse que la requête SQLite elle-même sur un flux
 * de cinquante offres.
 */
function etiquette(valeur) {
  const texte = typeof valeur === "string" ? valeur : JSON.stringify(valeur);
  // FNV-1a 32 bits. Pas cryptographique, et il n'a pas à l'être : on compare
  // une réponse avec elle-même, pas avec un adversaire.
  let h = 0x811c9dc5;
  for (let i = 0; i < texte.length; i++) {
    h ^= texte.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `W/"${(h >>> 0).toString(36)}-${texte.length.toString(36)}"`;
}

/**
 * Sert une valeur en JSON avec ETag et revalidation.
 *
 * `max-age` court plus `stale-while-revalidate` : le CDN ou le navigateur
 * peut servir une version d'il y a quelques secondes pendant qu'il en
 * redemande une fraîche. C'est le réglage qui convient à un flux de bons
 * plans — jamais critique à la seconde, toujours désagréable à attendre.
 */
function servir(req, res, valeur, { maxAge = 15, swr = 60 } = {}) {
  const tag = etiquette(valeur);
  res.set("Cache-Control", `public, max-age=${maxAge}, stale-while-revalidate=${swr}`);
  res.set("ETag", tag);
  if (req.headers["if-none-match"] === tag) return res.status(304).end();
  return res.json(valeur);
}

/** Ce que le cache contient, pour le tableau de bord. */
function etat() {
  return { generation, entrees: entrees.size, max: MAX_ENTREES, ttlMs: TTL_DEFAUT };
}

module.exports = { memo, invalider, etiquette, servir, etat, TTL_DEFAUT, MAX_ENTREES };
