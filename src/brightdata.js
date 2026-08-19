// brightdata.js — Récupère les résultats Google Shopping via le Browser API
// de Bright Data (navigateur distant piloté par Puppeteer), en repli quand
// SerpApi échoue (quota épuisé, panne). Voir fetchOffers.js pour la logique
// de choix entre les deux sources.
//
// Deux essais précédents (zone "Web Unlocker", zone "SERP API" en formats
// raw et json) ont tous échoué : aucun des deux ne rend le JavaScript, or
// les résultats Google Shopping sont injectés côté client (confirmé en
// prod : 0 caractère "€" sur 1,2 Mo de HTML reçu à chaque fois). Le Browser
// API pilote un vrai Chrome distant via CDP (Puppeteer) : la page est
// réellement rendue avant qu'on en lise le HTML.
//
// Coût réel (contrairement aux deux essais précédents, gratuits) : facturé
// au volume de données ($8/Go sur le compte actuel). Cette source ne doit
// donc JAMAIS être la première essayée pour du trafic récurrent (scan
// catalogue, recherches fréquentes) — seulement un repli quand SerpApi (peu
// coûteux, quota mensuel) est indisponible. Voir fetchOffers.js.
const puppeteer = require("puppeteer-core");
const cheerio = require("cheerio");
const { parsePrice } = require("./serpapi");

const BROWSER_HOST = process.env.BRIGHT_DATA_BROWSER_HOST;
const BROWSER_USER = process.env.BRIGHT_DATA_BROWSER_USER;
const BROWSER_PASS = process.env.BRIGHT_DATA_BROWSER_PASS;

function browserWsEndpoint() {
  if (!BROWSER_HOST || !BROWSER_USER || !BROWSER_PASS) return null;
  return `wss://${BROWSER_USER}:${BROWSER_PASS}@${BROWSER_HOST}`;
}

/**
 * Récupère les résultats Google Shopping pour une requête via un navigateur
 * distant Bright Data. Même forme de retour que fetchShoppingResults
 * (serpapi.js) : {name, price, seller, url, img} — sans _token.
 */
async function fetchShoppingResultsBrightData(query) {
  const wsEndpoint = browserWsEndpoint();
  if (!wsEndpoint) {
    throw new Error("Identifiants Bright Data Browser API manquants (BRIGHT_DATA_BROWSER_HOST/USER/PASS)");
  }

  const targetUrl = `https://www.google.com/search?${new URLSearchParams({
    q: query,
    tbm: "shop",
    gl: "fr",
    hl: "fr",
  })}`;

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    const page = await browser.newPage();
    try {
      await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 45000 });
      // Les résultats Shopping se chargent en JS après le rendu initial —
      // on attend leur apparition sans faire échouer la requête si absents
      // (page différente selon la requête : parfois pas de résultats Shopping).
      await page.waitForSelector('a[href*="/shopping/product/"]', { timeout: 8000 }).catch(() => {});
      const html = await page.content();
      const offers = parseGoogleShoppingHtml(html);
      if (offers.length === 0) {
        console.warn(`[brightdata] 0 offre extraite pour "${query}" (Browser API) — longueur HTML : ${html.length}`);
      }
      return offers;
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    if (browser) await browser.disconnect(); // ne PAS browser.close() : session distante gérée par Bright Data
  }
}

/**
 * Analyse le HTML (réellement rendu) d'une page de résultats Google
 * Shopping. Fonction pure, testable sans réseau à partir d'un extrait de
 * HTML capturé (voir test-brightdata-parser.js).
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
      seller: null, // pas d'extraction fiable du vendeur depuis ce HTML
      url: null, // jamais le lien Google en repli — pas de résolution du lien marchand direct ici
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
