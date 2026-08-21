// fetchPage.js — Récupérer une fiche marchande, même quand elle se défend.
//
// La surveillance lit le prix dans les données structurées d'une page
// produit. Encore faut-il obtenir la page : les grandes enseignes françaises
// refusent les requêtes venant d'un centre de données, quel que soit l'agent
// annoncé. Une requête directe depuis Railway se fait renvoyer un 403 chez
// Cdiscount, la Fnac ou Amazon — c'est-à-dire précisément chez les marchands
// qui comptent.
//
// D'où deux étages :
//
//   1. Requête directe, avec un agent identifiable. Gratuite, immédiate,
//      polie — et elle suffit chez beaucoup de marchands.
//   2. Repli sur l'API de Bright Data, facturée à la requête, uniquement
//      quand la première a échoué.
//
// ⚠️ Pourquoi cet étage-là fonctionne alors qu'une tentative précédente avait
// échoué : brightdata.js note que la zone SERP ne rendait pas le JavaScript,
// ce qui condamnait la lecture de Google Shopping (résultats injectés côté
// client). Une fiche produit marchande est un cas opposé : son JSON-LD est
// présent dans le HTML servi, puisqu'il existe pour être lu par les robots
// d'indexation. Le rendu JavaScript n'est donc pas nécessaire ici, et
// l'endpoint simple — et bien moins cher que le Browser API — convient.
const { logSourceEvent } = require("./db");

const AGENT = "RadarPrixBot/1.0 (+https://radarprix.fr/bot)";

/* Délai d'expiration, et ce n'est pas un réglage de confort : sans lui, un
   marchand qui accepte la connexion puis ne répond jamais fait attendre le
   programme indéfiniment. Observé en production — la découverte s'est
   arrêtée sans un mot, processeur au repos, plus aucune tâche planifiée
   n'ayant repris la main. Un serveur muet ne doit jamais pouvoir suspendre
   tout le reste. */
const DELAI_DEFAUT = 20000;

/** Délai courant, relu à chaque appel — un réglage figé au chargement du
 *  module ne pourrait plus être ajusté sans redéployer. */
function delaiMs() {
  const n = parseInt(process.env.FETCH_TIMEOUT_MS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DELAI_DEFAUT;
}

/** Signal d'abandon, avec repli pour les runtimes sans AbortSignal.timeout. */
function signalDelai(ms = delaiMs()) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms).unref?.();
  return ctrl.signal;
}
const ENDPOINT_BRIGHTDATA = "https://api.brightdata.com/request";

/* Garde-fou de facturation. Bright Data facture à la requête : 40 fiches
   relues toutes les quinze minutes font près de 4 000 requêtes par jour. Si
   toutes basculaient en repli, la note grimperait sans que rien ne le
   signale. Le plafond quotidien rend ce dérapage impossible ; le dépassement
   est consigné pour qu'il soit visible dans le panneau Santé plutôt que sur
   la facture. */
const PLAFOND_DEFAUT = 300;
let compteur = { jour: null, utilisees: 0 };

function jourCourant() {
  return new Date().toISOString().slice(0, 10);
}

function plafondQuotidien() {
  const n = parseInt(process.env.BRIGHT_DATA_MAX_PAR_JOUR || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : PLAFOND_DEFAUT;
}

/** Consomme une unité de quota si elle est disponible. */
function quotaDisponible() {
  const jour = jourCourant();
  if (compteur.jour !== jour) compteur = { jour, utilisees: 0 };
  if (compteur.utilisees >= plafondQuotidien()) return false;
  compteur.utilisees++;
  return true;
}

/** État du quota, pour le tableau de bord. */
function etatQuota() {
  const jour = jourCourant();
  const utilisees = compteur.jour === jour ? compteur.utilisees : 0;
  return { jour, utilisees, plafond: plafondQuotidien(), actif: Boolean(process.env.BRIGHT_DATA_API_KEY) };
}

/** Remise à zéro du compteur — utilisée par les tests. */
function reinitialiserQuota() {
  compteur = { jour: null, utilisees: 0 };
}

/** Requête directe : gratuite, et suffisante chez de nombreux marchands. */
async function directe(url, fetcher) {
  const res = await fetcher(url, {
    headers: {
      // Un agent identifiable et honnête : c'est la moindre des politesses
      // vis-à-vis des serveurs interrogés, et cela permet aux marchands de
      // nous contacter plutôt que de nous bloquer en silence.
      "User-Agent": AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: signalDelai(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Repli Bright Data. La zone est configurable : celle qui convient pour une
 * page marchande n'est pas forcément celle utilisée pour les moteurs de
 * recherche, et le nom appartient au compte.
 */
async function viaBrightData(url, fetcher) {
  const cle = process.env.BRIGHT_DATA_API_KEY;
  if (!cle) throw new Error("BRIGHT_DATA_API_KEY absente");
  if (!quotaDisponible()) {
    throw new Error(`plafond quotidien Bright Data atteint (${plafondQuotidien()} requêtes)`);
  }

  const res = await fetcher(ENDPOINT_BRIGHTDATA, {
    method: "POST",
    signal: signalDelai(delaiMs() * 2), // le déblocage est lent par nature
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cle}` },
    body: JSON.stringify({
      zone: process.env.BRIGHT_DATA_ZONE || "serp_api2",
      url,
      format: "raw",
      data_format: "html",
    }),
  });
  if (!res.ok) throw new Error(`Bright Data a répondu ${res.status}`);
  return res.text();
}

/**
 * Récupère le HTML d'une page, en basculant sur Bright Data si la requête
 * directe échoue et qu'une clé est configurée.
 *
 * @returns {Promise<{html: string, via: "directe"|"brightdata"}>}
 */
async function recupererPage(url, { fetcher = fetch } = {}) {
  try {
    return { html: await directe(url, fetcher), via: "directe" };
  } catch (echecDirect) {
    if (!process.env.BRIGHT_DATA_API_KEY) throw echecDirect;
    try {
      const html = await viaBrightData(url, fetcher);
      logSourceEvent("brightdata-page", true, `repli réussi — ${url}`);
      return { html, via: "brightdata" };
    } catch (echecRepli) {
      // On remonte les deux causes : sans cela, un plafond atteint se lit
      // comme un marchand injoignable, et on cherche du côté du marchand.
      throw new Error(`directe : ${echecDirect.message} ; repli : ${echecRepli.message}`);
    }
  }
}

module.exports = { recupererPage, etatQuota, reinitialiserQuota, signalDelai, delaiMs, AGENT, ENDPOINT_BRIGHTDATA };
