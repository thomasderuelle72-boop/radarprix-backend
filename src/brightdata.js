// brightdata.js — Tentative d'alimenter la recherche EN DIRECT (à la
// demande) et le scan catalogue via Bright Data, en repli/complément de
// SerpApi (voir fetchOffers.js). Voir CONSTAT ci-dessous avant de retoucher
// ce fichier : dans son état actuel, cette fonction ne renvoie jamais
// d'offres — c'est documenté, pas un bug caché.
//
// CONSTAT (vérifié en production, deux zones et deux formats testés) :
// les résultats Google Shopping (tbm=shop) sont injectés côté client après
// coup — jamais présents dans le HTML servi initialement par Google.
//   - Zone "Web Unlocker" (web_unlocker1), format "raw" : HTML reçu (~1,2 Mo)
//     sans un seul caractère "€" dedans.
//   - Zone "SERP API" (serp_api1), format "raw" + data_format "html" : même
//     résultat, HTML identique en substance.
//   - Zone "SERP API", format "json" : ne renvoie PAS de données structurées
//     comme chez SerpApi — juste {status_code, headers, body} où body est le
//     même HTML non rendu, enveloppé en JSON.
// Conclusion : aucun mode de ces deux produits Bright Data n'exécute le
// JavaScript de la page Google Shopping. Il faudrait leur produit "Browser
// API" (navigateur distant piloté, différent de Web Unlocker/SERP API) pour
// obtenir le HTML réellement rendu — pas encore mis en place.
//
// Le code ci-dessous reste branché (voir fetchOffers.js) parce qu'il est
// sans risque : en l'absence d'offres, l'appelant bascule automatiquement
// sur SerpApi. Le jour où une zone Browser API est configurée, il suffira
// d'adapter la requête HTTP ci-dessous ; parseGoogleShoppingHtml() cible déjà
// des signaux structurels stables (lien de fiche produit, rôle ARIA
// "heading") et n'aura probablement pas besoin de changer.
const cheerio = require("cheerio");
const { parsePrice } = require("./serpapi");

const BRIGHT_DATA_API_KEY = process.env.BRIGHT_DATA_API_KEY;
const BRIGHT_DATA_ZONE = process.env.BRIGHT_DATA_ZONE || "serp_api1";
const API_URL = "https://api.brightdata.com/request";

/**
 * Récupère les résultats Google Shopping pour une requête via Bright Data.
 * Même forme de retour que fetchShoppingResults (serpapi.js) : {name, price,
 * seller, url, img} — sans _token (spécifique à SerpApi). Voir CONSTAT en
 * tête de fichier : renvoie [] tant qu'aucune zone ne rend le JS.
 */
async function fetchShoppingResultsBrightData(query) {
  if (!BRIGHT_DATA_API_KEY) {
    throw new Error("BRIGHT_DATA_API_KEY manquante");
  }
  const targetUrl = `https://www.google.com/search?${new URLSearchParams({
    q: query,
    tbm: "shop",
    gl: "fr",
    hl: "fr",
  })}`;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BRIGHT_DATA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ zone: BRIGHT_DATA_ZONE, url: targetUrl, format: "raw", data_format: "html" }),
  });

  if (!res.ok) {
    throw new Error(`Bright Data a répondu ${res.status} : ${(await res.text()).slice(0, 300)}`);
  }
  const html = await res.text();
  const offers = parseGoogleShoppingHtml(html);

  if (offers.length === 0) {
    console.warn(`[brightdata] 0 offre extraite pour "${query}" (JS non rendu par la zone actuelle, voir CONSTAT dans brightdata.js) — longueur HTML : ${html.length}`);
  }
  return offers;
}

/**
 * Analyse le HTML d'une page de résultats Google Shopping. Fonction pure,
 * testable sans réseau à partir d'un extrait de HTML capturé (voir
 * test-brightdata-parser.js). Prête à fonctionner dès que la requête
 * ci-dessus renverra du HTML réellement rendu.
 */
function parseGoogleShoppingHtml(html) {
  const $ = cheerio.load(html);
  const offers = [];

  $('a[href*="/shopping/product/"]').each((_, el) => {
    const $a = $(el);
    const $card = $a.closest("div");
    const text = $card.text();

    const priceMatch = text.match(/(\d[\d\s.,]*)\s?€/);
    if (!priceMatch) return;
    // Même logique que parsePrice() dans serpapi.js, y compris pour les
    // prix avec séparateur de milliers ("1 299,99 €", "1.299,99 €").
    const price = parsePrice(priceMatch[1]);
    if (!Number.isFinite(price) || price <= 0) return;

    const title = $card.find('[role="heading"]').first().text().trim() || $a.attr("aria-label") || "";
    if (!title) return;

    offers.push({
      name: title,
      price,
      seller: null, // pas d'extraction fiable du vendeur depuis ce HTML (voir note en tête de fichier)
      url: null, // jamais le lien Google en repli — voir note en tête de fichier
      img: $card.find("img").first().attr("src") || null,
    });
  });

  // Dédoublonne (le même produit peut apparaître dans plusieurs blocs imbriqués).
  const seen = new Set();
  return offers.filter((o) => {
    const key = `${o.name}|${o.price}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { fetchShoppingResultsBrightData, parseGoogleShoppingHtml };
