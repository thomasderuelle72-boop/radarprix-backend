// brightdata.js — Alimente la recherche EN DIRECT (à la demande, quand un
// visiteur tape une recherche absente du catalogue déjà scanné) via l'API
// SERP de Bright Data, pour ne pas consommer le quota SerpApi (~100
// requêtes/mois, réservé au scan catalogue planifié de cron.js/scanBatch.js)
// sur des recherches utilisateur potentiellement fréquentes et imprévisibles.
//
// Premier essai avec une zone "Web Unlocker" (web_unlocker1) : échec — ce
// produit ne rend pas le JavaScript, or les résultats Google Shopping sont
// injectés côté client, donc absents du HTML brut (confirmé en prod : 0
// occurrence de "€" sur 1,2 Mo de page). La zone "SERP API" (serp_api1),
// elle, rend le JS côté Bright Data avant de renvoyer la page — c'est le bon
// produit pour ce cas d'usage.
//
// Contrairement à SerpApi (serpapi.js), qui renvoie du JSON déjà structuré,
// l'API SERP Bright Data (en format "raw") renvoie ici la page HTML rendue :
// c'est à nous de l'analyser. Le HTML de Google change régulièrement, donc
// ce parsing vise des signaux structurels stables (liens vers une fiche
// produit, rôle ARIA "heading") plutôt que des noms de classes CSS.
//
// Limite assumée : contrairement à SerpApi (resolveDirectLink via son API
// "immersive product"), on n'a pas ici de moyen fiable de résoudre le lien
// DIRECT du marchand — seulement la fiche produit Google. Par cohérence avec
// la règle du projet ("jamais le lien Google en repli, soit le vrai lien
// marchand, soit rien"), les offres Bright Data ont donc url: null.
const cheerio = require("cheerio");

const BRIGHT_DATA_API_KEY = process.env.BRIGHT_DATA_API_KEY;
const BRIGHT_DATA_ZONE = process.env.BRIGHT_DATA_ZONE || "serp_api1";
const API_URL = "https://api.brightdata.com/request";

/**
 * Récupère les résultats Google Shopping pour une requête, via l'API SERP
 * Bright Data. Même forme de retour que fetchShoppingResults (serpapi.js) :
 * {name, price, seller, url, img} — sans _token (spécifique à SerpApi).
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

  if (process.env.BRIGHT_DATA_DEBUG === "true") {
    // Deux essais précédents (zones web_unlocker1 et serp_api1, toutes deux
    // en format "raw") ont renvoyé une page sans le moindre "€" malgré
    // data_format:"html" — donc probablement pas de rendu JS effectif dans
    // ce mode. On teste ici en parallèle le format "json" documenté par
    // Bright Data pour l'API SERP, qui déclenche normalement leur propre
    // extraction structurée côté serveur (comme SerpApi), sans qu'on ait à
    // parser du HTML nous-mêmes.
    try {
      const jsonRes = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${BRIGHT_DATA_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ zone: BRIGHT_DATA_ZONE, url: targetUrl, format: "json" }),
      });
      const jsonText = await jsonRes.text();
      console.warn(
        `[brightdata] DEBUG format=json → status ${jsonRes.status}, ${jsonText.length} caractères, aperçu : ${jsonText.slice(0, 4000)}`
      );
    } catch (e) {
      console.warn(`[brightdata] DEBUG format=json a échoué : ${e.message}`);
    }
  }

  const offers = parseGoogleShoppingHtml(html);

  if (offers.length === 0) {
    // Le HTML de Google évolue souvent : si le parsing ne trouve plus rien,
    // on logue un extrait pour pouvoir ajuster les sélecteurs sans deviner
    // à l'aveugle. Ne fait jamais échouer l'appel : le code appelant bascule
    // simplement sur SerpApi en repli.
    console.warn(`[brightdata] 0 offre extraite pour "${query}" — longueur HTML : ${html.length}`);
  }
  return offers;
}

/**
 * Analyse le HTML brut d'une page de résultats Google Shopping. Fonction
 * pure, testable sans réseau à partir d'un extrait de HTML capturé.
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
    // Même logique que parsePrice() dans serpapi.js : on ne garde que
    // chiffres/virgule/point, la virgule devient le séparateur décimal —
    // gère aussi bien "299,99" que "1 299,99" (l'espace est déjà filtré).
    const cleaned = priceMatch[1].replace(/[^\d,.-]/g, "").replace(",", ".");
    const price = parseFloat(cleaned);
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
