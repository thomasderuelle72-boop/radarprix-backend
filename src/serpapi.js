// serpapi.js — Interroge Google Shopping via SerpApi.
// Documentation : https://serpapi.com/google-shopping-api
// Nécessite SERPAPI_KEY dans .env (compte gratuit sur serpapi.com).

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const BASE_URL = "https://serpapi.com/search.json";

/**
 * Récupère les résultats Google Shopping pour une requête donnée.
 * @param {string} query - ex: "PlayStation 5 Slim"
 * @returns {Promise<Array>} liste d'offres normalisées {name, price, seller, url, img, _token}
 */
async function fetchShoppingResults(query) {
  if (!SERPAPI_KEY) {
    throw new Error("SERPAPI_KEY manquante — ajoute-la dans le fichier .env");
  }
  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    gl: "fr",
    hl: "fr",
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
      // Repli : la page Google (pas le marchand). Remplacé par resolveDirectLink
      // quand c'est possible — ne jamais compter dessus comme lien final.
      url: r.product_link || null,
      img: r.thumbnail || null,
      oldPrice: parseOptionalPrice(r.old_price || r.extracted_old_price),
      delivery: r.delivery || null,
      condition: r.second_hand_condition || null,
      rating: typeof r.rating === "number" ? r.rating : null,
      reviews: typeof r.reviews === "number" ? r.reviews : null,
      multipleSources: r.multiple_sources || null,
      badge: r.badge || r.tag || null,
      // Token permettant de retrouver le vrai lien marchand.
      _token: r.immersive_product_page_token || null,
    }))
    .filter((o) => o.name && o.price > 0);
}

/**
 * À partir du token d'un résultat Google Shopping, retrouve le lien DIRECT
 * vers la fiche du marchand (pas la page Google). Coûte 1 requête SerpApi
 * de plus : à réserver aux offres qu'on affiche vraiment (les flaggées).
 * @returns {Promise<string|null>} l'URL directe du marchand, ou null si introuvable
 */
async function resolveDirectLink(token, sellerHint, priceHint) {
  if (!token || !SERPAPI_KEY) return null;
  try {
    const params = new URLSearchParams({
      engine: "google_immersive_product",
      page_token: token,
      api_key: SERPAPI_KEY,
    });
    const res = await fetch(`${BASE_URL}?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    const stores = data.product_results?.stores || [];
    return pickBestStore(stores, sellerHint, priceHint);
  } catch {
    return null;
  }
}

/**
 * Choisit, parmi les vendeurs renvoyés par l'API immersive, celui qui
 * correspond le mieux à l'offre affichée (même vendeur, sinon prix le
 * plus proche). Fonction pure, testable sans réseau.
 */
function pickBestStore(stores, sellerHint, priceHint) {
  if (!stores || stores.length === 0) return null;

  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (sellerHint) {
    const hint = norm(sellerHint);
    const bySeller = stores.find(
      (s) => hint && (norm(s.name).includes(hint) || hint.includes(norm(s.name)))
    );
    if (bySeller?.link) return bySeller.link;
  }

  if (priceHint) {
    const withPrice = stores.filter((s) => s.link && typeof s.extracted_price === "number");
    if (withPrice.length > 0) {
      const closest = withPrice.sort(
        (a, b) => Math.abs(a.extracted_price - priceHint) - Math.abs(b.extracted_price - priceHint)
      )[0];
      if (closest) return closest.link;
    }
  }

  return stores.find((s) => s.link)?.link || null;
}

function parseOptionalPrice(raw) {
  const price = parsePrice(raw);
  return price > 0 ? price : null;
}

function parsePrice(raw) {
  if (typeof raw === "number") return raw;
  if (!raw) return 0;

  const compact = String(raw).replace(/[^\d,.-]/g, "");
  if (!compact) return 0;

  const lastComma = compact.lastIndexOf(",");
  const lastDot = compact.lastIndexOf(".");
  const decimalIndex = Math.max(lastComma, lastDot);
  const decimalSeparator = compact[decimalIndex];

  const normalized = decimalSeparator
    ? compact
        .slice(0, decimalIndex)
        .replace(/[^\d-]/g, "") +
      "." +
      compact.slice(decimalIndex + 1).replace(/[^\d]/g, "")
    : compact.replace(/[^\d-]/g, "");

  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

module.exports = { fetchShoppingResults, resolveDirectLink, pickBestStore, parsePrice, parseOptionalPrice };
