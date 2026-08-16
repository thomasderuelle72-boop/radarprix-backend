// Test d'intégration : simule les réponses SerpApi pour vérifier que
// tout le pipeline (scan → analyse → résolution des liens) fonctionne
// sans clé API réelle ni accès réseau.
process.env.SERPAPI_KEY = "fake-key-for-test";

const realFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes("engine=google_shopping")) {
    return {
      ok: true,
      json: async () => ({
        shopping_results: [
          { title: "PlayStation 5 Slim", price: "549,99 €", source: "Fnac", product_link: "https://google.example/1", thumbnail: "https://img.example/1.jpg", immersive_product_page_token: "TOKEN_FNAC" },
          { title: "PlayStation 5 Slim", price: "539,00 €", source: "Amazon", product_link: "https://google.example/2", thumbnail: "https://img.example/2.jpg", immersive_product_page_token: "TOKEN_AMAZON" },
          { title: "PlayStation 5 Slim", price: "89,99 €", source: "Boutique Louche", product_link: "https://google.example/3", thumbnail: "https://img.example/3.jpg", immersive_product_page_token: "TOKEN_LOUCHE" },
        ],
      }),
    };
  }
  if (u.includes("engine=google_immersive_product")) {
    const token = new URL(u).searchParams.get("page_token");
    const storesByToken = {
      TOKEN_FNAC: [{ name: "Fnac", link: "https://www.fnac.com/vrai-produit-fnac", extracted_price: 549.99 }],
      TOKEN_AMAZON: [{ name: "Amazon.fr", link: "https://www.amazon.fr/vrai-produit-amazon", extracted_price: 539 }],
      TOKEN_LOUCHE: [{ name: "Boutique Louche Marketplace", link: "https://boutique-louche.example/produit", extracted_price: 89.99 }],
    };
    return { ok: true, json: async () => ({ product_results: { stores: storesByToken[token] || [] } }) };
  }
  return realFetch(url);
};

const { insertSnapshots } = require("./src/db");
// On vide la table pour un test propre (SQLite en mémoire du fichier de test).

async function run() {
  // On réimplémente ici la logique de scanQuery pour tester le pipeline complet
  // (server.js exporte l'app Express, pas scanQuery directement).
  const { fetchShoppingResults, resolveDirectLink } = require("./src/serpapi");
  const { analyzeOffers } = require("./src/algorithm");

  const offers = await fetchShoppingResults("PlayStation 5 Slim");
  console.log(`Offres reçues : ${offers.length}`);

  const analyzed = analyzeOffers(offers).filter((o) => o.verdict !== "normal").sort((a, b) => b.score - a.score);
  console.log(`Offres flaggées (erreur/deal) : ${analyzed.length}`);

  for (const item of analyzed) {
    const link = await resolveDirectLink(item._token, item.seller, item.price);
    item.url = link;
    console.log(`  ${item.seller.padEnd(24)} ${item.price}€ → ${item.verdict.toUpperCase().padEnd(7)} → lien : ${link}`);
  }

  const boutiqueLouche = analyzed.find((o) => o.seller === "Boutique Louche");
  const isDirectLink = boutiqueLouche && boutiqueLouche.url === "https://boutique-louche.example/produit";
  const noGoogleLinkLeaked = analyzed.every((o) => !o.url || !o.url.includes("google.example"));

  console.log(isDirectLink ? "\n✅ Le lien direct marchand est bien résolu (pas la page Google)" : "\n❌ ÉCHEC : lien direct non résolu");
  console.log(noGoogleLinkLeaked ? "✅ Aucun lien Google ne fuite dans le résultat final" : "❌ ÉCHEC : un lien Google est encore présent");
}

run().then(() => console.log("\nTest d'intégration terminé.")).catch((e) => { console.error("ERREUR:", e); process.exit(1); });
