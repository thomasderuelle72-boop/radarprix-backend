// sources/ebay.js — Une deuxième opinion sur le prix, gratuitement.
//
// Le détecteur d'anomalies a besoin d'une chose que rien ne lui donnait
// jusqu'ici en quantité : plusieurs prix INDÉPENDANTS pour le même produit.
// Comparer un marchand à son propre passé attrape les décrochages ; comparer
// plusieurs marchands entre eux attrape ce qu'un seul historique ne peut pas
// voir — un prix anormal dès la première observation.
//
// L'API Browse d'eBay répond à ça sans rien coûter : jeton applicatif obtenu
// par identifiants client, marché français, et surtout recherche PAR EAN.
// C'est ce dernier point qui compte : le code-barres est la seule clé qui
// désigne le même produit chez deux vendeurs sans dépendre de la façon dont
// chacun rédige son titre.
//
// Sans identifiants, la source est simplement ignorée (voir sources/index.js).
const { versDateSql } = require("../dealsStore");

const OAUTH = "https://api.ebay.com/identity/v1/oauth2/token";
const RECHERCHE = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const PORTEE = "https://api.ebay.com/oauth/api_scope";

// Jeton mis en cache : il vaut deux heures, et en redemander un à chaque
// requête gaspillerait un appel sur deux.
let jetonCache = { valeur: null, expireA: 0 };

/** Réinitialise le cache du jeton — utilisé par les tests. */
function oublierJeton() {
  jetonCache = { valeur: null, expireA: 0 };
}

/**
 * Jeton applicatif, par le flux « client credentials ». Ne donne accès
 * qu'aux données publiques : aucun compte utilisateur n'est engagé.
 */
async function obtenirJeton({ fetcher = fetch } = {}) {
  const id = process.env.EBAY_APP_ID;
  const secret = process.env.EBAY_CERT_ID;
  if (!id || !secret) throw new Error("EBAY_APP_ID / EBAY_CERT_ID manquants");

  if (jetonCache.valeur && Date.now() < jetonCache.expireA) return jetonCache.valeur;

  const res = await fetcher(OAUTH, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(PORTEE)}`,
  });
  if (!res.ok) throw new Error(`eBay a refusé les identifiants (${res.status})`);

  const json = await res.json();
  if (!json.access_token) throw new Error("eBay n'a pas renvoyé de jeton");
  const jeton = json.access_token;

  // Marge de sécurité d'une minute : un jeton qui expire pendant l'appel
  // suivant produirait un 401 incompréhensible.
  jetonCache = {
    valeur: jeton,
    expireA: Date.now() + Math.max(0, (json.expires_in || 7200) - 60) * 1000,
  };
  return jeton;
}

/** Normalise un résultat eBay vers le modèle deals. */
function normaliserArticle(raw) {
  const id = raw?.itemId;
  const titre = raw?.title;
  const prix = parseFloat(raw?.price?.value);
  if (!id || !titre || !Number.isFinite(prix) || prix <= 0) return null;

  // L'état de l'article décide de la section où il atterrit : mélanger du
  // reconditionné au neuf fausserait toute comparaison de prix.
  const etatBrut = (raw.condition || "").toLowerCase();
  const etat = /refurb|reconditionn/.test(etatBrut)
    ? "reconditionne"
    : /used|occasion|good|acceptable/.test(etatBrut)
      ? "occasion"
      : "neuf";

  return {
    source: "ebay",
    externalId: id,
    detector: etat === "neuf" ? "D3" : "D4",
    type: etat === "neuf" ? "produit" : "occasion",
    title: titre,
    url: raw.itemWebUrl || null,
    imageUrl: raw.image?.imageUrl || raw.thumbnailImages?.[0]?.imageUrl || null,
    merchant: raw.seller?.username ? `eBay — ${raw.seller.username}` : "eBay",
    itemCondition: etat,
    price: prix,
    // Aucune référence : eBay donne un prix, pas une valeur de marché. La
    // comparaison se fait ailleurs, contre les autres sources.
    referencePrice: null,
    currency: raw.price?.currency || "EUR",
    // Le code-barres est la clé de jointure entre sources. Quand eBay le
    // fournit, il vaut mieux que n'importe quel rapprochement par titre.
    gtin: raw.epid || null,
    expiresAt: versDateSql(raw.itemEndDate),
    payload: raw,
  };
}

/**
 * Cherche des articles sur le marché français.
 *
 * @param {object} opts
 * @param {string} [opts.q]     mots-clés
 * @param {string} [opts.gtin]  code-barres — préférable à des mots-clés
 * @param {number} [opts.limite]
 */
async function chercher({ q = null, gtin = null, limite = 50, fetcher = fetch } = {}) {
  if (!q && !gtin) throw new Error("Il faut des mots-clés ou un code-barres.");
  const jeton = await obtenirJeton({ fetcher });

  const params = new URLSearchParams({ limit: String(Math.min(limite, 200)) });
  if (gtin) params.set("gtin", gtin);
  else params.set("q", q);

  const res = await fetcher(`${RECHERCHE}?${params}`, {
    headers: {
      Authorization: `Bearer ${jeton}`,
      // Sans cet en-tête, eBay répond sur le marché américain : des prix en
      // dollars, des vendeurs qui ne livrent pas ici, et une comparaison qui
      // ne veut rien dire.
      "X-EBAY-C-MARKETPLACE-ID": process.env.EBAY_MARKETPLACE || "EBAY_FR",
      Accept: "application/json",
    },
  });

  if (res.status === 401) {
    // Jeton périmé malgré la marge : on le jette et on laisse le prochain
    // passage en redemander un, plutôt que d'échouer en boucle.
    oublierJeton();
    throw new Error("eBay a refusé le jeton (401) — il sera renouvelé au prochain passage.");
  }
  if (!res.ok) throw new Error(`eBay a répondu ${res.status}`);

  const json = await res.json();
  return (json.itemSummaries || []).map(normaliserArticle).filter(Boolean);
}

module.exports = { chercher, obtenirJeton, normaliserArticle, oublierJeton, OAUTH, RECHERCHE };
