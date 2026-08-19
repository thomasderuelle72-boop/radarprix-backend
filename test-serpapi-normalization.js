process.env.SERPAPI_KEY = "fake";

const assert = require("node:assert/strict");
const { fetchShoppingResults } = require("./src/serpapi");

global.fetch = async () => ({
  ok: true,
  json: async () => ({
    shopping_results: [
      {
        title: "iPhone 15 128 Go",
        price: "799,00 €",
        old_price: "899,00 €",
        source: "Fnac",
        product_link: "https://google.example/product",
        thumbnail: "https://img.example/iphone.jpg",
        delivery: "Livraison gratuite",
        second_hand_condition: "neuf",
        rating: 4.7,
        reviews: 1234,
        multiple_sources: "Comparer les prix",
        tag: "PROMO",
        immersive_product_page_token: "token-1",
      },
    ],
  }),
});

(async () => {
  console.log("── Normalisation SerpApi enrichie ──");
  const [offer] = await fetchShoppingResults("iphone 15");
  assert.equal(offer.price, 799);
  assert.equal(offer.oldPrice, 899);
  assert.equal(offer.delivery, "Livraison gratuite");
  assert.equal(offer.condition, "neuf");
  assert.equal(offer.rating, 4.7);
  assert.equal(offer.reviews, 1234);
  assert.equal(offer.badge, "PROMO");
  assert.equal(offer._token, "token-1");
  console.log("✅ Champs prix, condition, livraison et signaux marchand normalisés");
})();
