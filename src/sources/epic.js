// sources/epic.js — Détecteur D2 : jeux offerts sur l'Epic Games Store.
//
// Pourquoi cette source plutôt qu'un scan de prix : elle est DÉTERMINISTE.
// Un jeu est offert ou il ne l'est pas ; il n'y a ni seuil à régler, ni
// médiane à calculer, ni faux positif possible. C'est le meilleur rapport
// effort/résultat de tout le projet — quelques dizaines de lignes pour du
// contenu fiable qui se renouvelle chaque semaine tout seul.
//
// Epic expose publiquement le catalogue de ses promotions. L'analyse de la
// réponse est volontairement séparée de l'appel réseau : elle est ainsi
// testable hors ligne, sur des extraits réels, ce qui est la seule façon de
// vérifier le comportement d'un format qu'on ne maîtrise pas.

const EPIC_URL =
  "https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions";

/** Image la plus grande disponible, dans l'ordre de préférence d'Epic. */
function choisirImage(keyImages) {
  const ordre = ["OfferImageWide", "DieselStoreFrontWide", "OfferImageTall", "Thumbnail"];
  for (const type of ordre) {
    const img = (keyImages || []).find((i) => i && i.type === type && i.url);
    if (img) return img.url;
  }
  return (keyImages || []).find((i) => i && i.url)?.url || null;
}

/**
 * Adresse publique de la fiche. Epic a plusieurs emplacements pour le même
 * identifiant d'URL selon l'ancienneté de la fiche : on les essaie dans
 * l'ordre plutôt que de supposer un seul champ, sinon une partie des jeux
 * ressortirait sans lien exploitable.
 */
function choisirSlug(el) {
  return (
    el.catalogNs?.mappings?.find((m) => m?.pageSlug)?.pageSlug ||
    el.offerMappings?.find((m) => m?.pageSlug)?.pageSlug ||
    el.productSlug ||
    el.urlSlug ||
    null
  );
}

/** Fenêtres promotionnelles en cours et à venir, aplaties. */
function fenetres(el) {
  const p = el.promotions;
  if (!p) return [];
  const plat = (groupes) =>
    (groupes || []).flatMap((g) => g?.promotionalOffers || []).filter(Boolean);
  return [...plat(p.promotionalOffers), ...plat(p.upcomingPromotionalOffers)];
}

/**
 * Transforme la réponse Epic en deals prêts pour dealsStore.
 *
 * Deux conditions cumulatives pour retenir un jeu : le prix remisé doit être
 * nul ET une fenêtre promotionnelle doit exister. Le catalogue renvoyé
 * contient aussi des promotions payantes (−30 %, −50 %) : ne filtrer que sur
 * la présence d'une promotion ferait entrer des jeux à prix réduit dans la
 * rubrique « gratuit ».
 *
 * @param {object} json - corps de la réponse Epic
 * @param {Date} [maintenant] - instant de référence, paramétrable pour les tests
 */
function parseEpicFreeGames(json, maintenant = new Date()) {
  const elements = json?.data?.Catalog?.searchStore?.elements || [];
  const deals = [];

  for (const el of elements) {
    if (!el || !el.id || !el.title) continue;

    const total = el.price?.totalPrice;
    // Prix Epic en unités mineures de la devise (1999 = 19,99 €).
    const remise = total?.discountPrice;
    const origine = total?.originalPrice;
    if (remise !== 0) continue; // pas gratuit : promotion payante ou plein tarif

    // On retient la fenêtre en cours si elle existe, sinon la prochaine à
    // venir — un jeu annoncé pour la semaine suivante est du contenu utile,
    // et starts_at empêche de le servir avant l'heure.
    const toutes = fenetres(el)
      .filter((f) => f.startDate && f.endDate)
      .map((f) => ({ debut: new Date(f.startDate), fin: new Date(f.endDate), brut: f }))
      .filter((f) => !Number.isNaN(f.debut.getTime()) && !Number.isNaN(f.fin.getTime()))
      .filter((f) => f.fin > maintenant)
      .sort((a, b) => a.debut - b.debut);

    if (toutes.length === 0) continue; // gratuit mais sans fenêtre : jeu free-to-play
    const f = toutes.find((x) => x.debut <= maintenant) || toutes[0];

    const slug = choisirSlug(el);
    const prixOrigine = Number.isFinite(origine) ? origine / 100 : null;

    deals.push({
      source: "epic",
      externalId: el.id,
      detector: "D2",
      type: "gratuit",
      title: el.title,
      description: el.description || null,
      url: slug ? `https://store.epicgames.com/fr/p/${slug}` : null,
      imageUrl: choisirImage(el.keyImages),
      merchant: "Epic Games Store",
      category: "gaming",
      price: 0,
      // Le prix habituel du jeu, relevé chez le marchand lui-même : c'est
      // bien une référence observée, pas un prix barré promotionnel.
      referencePrice: prixOrigine && prixOrigine > 0 ? prixOrigine : null,
      currency: total?.currencyCode || "EUR",
      startsAt: f.debut.toISOString(),
      expiresAt: f.fin.toISOString(),
      payload: { offerId: el.id, namespace: el.namespace || null, slug },
    });
  }

  return deals;
}

/**
 * Interroge Epic. Le client HTTP est injectable pour que les tests puissent
 * vérifier la gestion des pannes sans réseau.
 * @returns {Promise<Array>} deals normalisés
 */
async function fetchEpicFreeGames({ fetcher = fetch, locale = "fr-FR", pays = "FR" } = {}) {
  const url = `${EPIC_URL}?locale=${encodeURIComponent(locale)}&country=${encodeURIComponent(pays)}&allowCountries=${encodeURIComponent(pays)}`;
  const res = await fetcher(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Epic a répondu ${res.status}`);
  return parseEpicFreeGames(await res.json());
}

module.exports = { EPIC_URL, parseEpicFreeGames, fetchEpicFreeGames, choisirSlug, choisirImage };
