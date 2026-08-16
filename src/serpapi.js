// serpapi.js — Interroge Google Shopping via SerpApi.
// Documentation : https://serpapi.com/google-shopping-api
// Nécessite SERPAPI_KEY dans .env (compte gratuit sur serpapi.com).

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const BASE_URL = "https://serpapi.com/search.json";

/**
 * Récupère les résultats Google Shopping pour une requête donnée.
 * @param {string} query - ex: "RAM DDR4 SODIMM 8Go 3200MHz"
 * @returns {Promise<Array>} liste d'offres normalisées {name, price, seller, url, img}
 */
async function fetchShoppingResults(query) {
  if (!SERPAPI_KEY) {
    throw new Error("SERPAPI_KEY manquante — ajoute-la dans le fichier .env");
  }
  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    gl: "fr", // pays : France
    hl: "fr", // langue : français
    api_key: SERPAPI_KEY,
  });

  const res = await fetch(`${BASE_URL}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`SerpApi a répondu ${res.status} : ${await res.text()}`);
  }
  const data = await res.json();
  const results = data.shopping_results || [];

  return results
    .map((r) => ({
      name: r.title,
      price: parsePrice(r.price || r.extracted_price),
      seller: r.source || null,
      url: r.product_link || r.link || null,
      img: r.thumbnail || null,
    }))
    .filter((o) => o.name && o.price > 0);
}

function parsePrice(raw) {
  if (typeof raw === "number") return raw;
  if (!raw) return 0;
  // "44,90 €" -> 44.90
  const cleaned = String(raw).replace(/[^\d,.-]/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

module.exports = { fetchShoppingResults };
