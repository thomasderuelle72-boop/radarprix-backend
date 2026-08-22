// tests/extraction.test.js — Lecture des fiches produits telles que les
// marchands les publient.
//
// Ces pages sont écrites à la main d'après le vocabulaire schema.org et les
// formes qu'on rencontre réellement : un @graph, une AggregateOffer, un
// priceSpecification de type ListPrice, du microdata, de l'OpenGraph. Si
// l'extraction cesse de lire l'une d'elles, des cartes entières perdraient
// leur image, leur description ou leur remise sans que rien ne le signale.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { produitDepuisHtml, extraireJsonLd } = require("../src/extraction.js");

const PAGE_JSONLD = `<!doctype html><html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "BreadcrumbList", "itemListElement": [] },
    {
      "@type": "Product",
      "name": "Casque Sony WH-1000XM5",
      "description": "Casque à réduction de bruit, 30 h d'autonomie.",
      "image": ["https://img.marchand.fr/casque-1.jpg", "https://img.marchand.fr/casque-2.jpg"],
      "brand": { "@type": "Brand", "name": "Sony" },
      "sku": "SONY-WH1000XM5-B",
      "color": "Noir",
      "additionalProperty": [
        { "@type": "PropertyValue", "name": "Autonomie", "value": "30 heures" },
        { "@type": "PropertyValue", "name": "Connectivité", "value": "Bluetooth 5.2" }
      ],
      "offers": {
        "@type": "Offer",
        "price": "279.99",
        "priceCurrency": "EUR",
        "availability": "https://schema.org/InStock",
        "priceValidUntil": "2026-09-30",
        "itemCondition": "https://schema.org/NewCondition",
        "priceSpecification": [
          { "@type": "UnitPriceSpecification", "priceType": "https://schema.org/ListPrice", "price": "419.00", "priceCurrency": "EUR" }
        ]
      }
    }
  ]
}
</script></head><body></body></html>`;

const PAGE_AGREGEE = `<html><head>
<script type="application/ld+json">
[{
  "@type": "Product",
  "name": "Aspirateur Dyson V15",
  "image": "https://img.marchand.fr/dyson.jpg",
  "offers": {
    "@type": "AggregateOffer",
    "lowPrice": "449,00",
    "highPrice": "599,00",
    "priceCurrency": "EUR",
    "offerCount": 4
  }
}]
</script></head><body></body></html>`;

const PAGE_MICRODATA = `<html><body>
<div itemscope itemtype="https://schema.org/Product">
  <span itemprop="name">Nintendo Switch OLED</span>
  <img itemprop="image" src="https://img.marchand.fr/switch.jpg" />
  <meta itemprop="description" content="Console avec écran OLED 7 pouces." />
  <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
    <meta itemprop="price" content="299.99" />
    <meta itemprop="priceCurrency" content="EUR" />
    <link itemprop="availability" href="https://schema.org/InStock" />
    <meta itemprop="priceValidUntil" content="2026-12-31" />
  </div>
</div></body></html>`;

const PAGE_OPENGRAPH = `<html><head>
<meta property="og:title" content="Machine Nespresso Vertuo Pop" />
<meta property="og:description" content="Machine à café à capsules." />
<meta property="og:image" content="https://img.marchand.fr/nespresso.jpg" />
<meta property="product:price:amount" content="59.90" />
<meta property="product:original_price:amount" content="99.00" />
<meta property="product:price:currency" content="EUR" />
</head><body></body></html>`;

describe("extraireJsonLd", () => {
  it("aplatit un @graph et ignore un bloc mal formé", () => {
    const html = `${PAGE_JSONLD}<script type="application/ld+json">{ ceci n'est pas du json }</script>`;
    const objets = extraireJsonLd(html);
    // Le bloc cassé ne doit pas faire perdre le bloc valide de la page.
    expect(objets.some((o) => o["@type"] === "Product")).toBe(true);
  });
});

describe("produitDepuisHtml — JSON-LD", () => {
  it("lit tout ce qu'une carte doit montrer", () => {
    const p = produitDepuisHtml(PAGE_JSONLD);
    expect(p.source).toBe("jsonld");
    expect(p.nom).toBe("Casque Sony WH-1000XM5");
    expect(p.description).toContain("réduction de bruit");
    // Plusieurs images : la première fait l'affaire.
    expect(p.image).toBe("https://img.marchand.fr/casque-1.jpg");
    expect(p.marque).toBe("Sony");
    expect(p.prix).toBe(279.99);
    // Le prix barré vient d'un priceSpecification de type ListPrice.
    expect(p.prixReference).toBe(419);
    expect(p.disponible).toBe(true);
    expect(p.finOffre).toBe("2026-09-30T00:00:00.000Z");
    expect(p.etat).toBe("neuf");
    expect(p.sku).toBe("SONY-WH1000XM5-B");
  });

  it("rapporte les caractéristiques déclarées", () => {
    const p = produitDepuisHtml(PAGE_JSONLD);
    expect(p.caracteristiques).toEqual([
      { nom: "Autonomie", valeur: "30 heures" },
      { nom: "Connectivité", valeur: "Bluetooth 5.2" },
      { nom: "Couleur", valeur: "Noir" },
    ]);
  });

  it("prend le prix le plus bas d'une offre agrégée, le plus haut en référence", () => {
    const p = produitDepuisHtml(PAGE_AGREGEE);
    expect(p.prix).toBe(449);
    expect(p.prixReference).toBe(599);
  });
});

describe("produitDepuisHtml — replis", () => {
  it("lit une page en microdata", () => {
    const p = produitDepuisHtml(PAGE_MICRODATA);
    expect(p.source).toBe("microdata");
    expect(p.nom).toBe("Nintendo Switch OLED");
    expect(p.prix).toBe(299.99);
    expect(p.image).toBe("https://img.marchand.fr/switch.jpg");
    expect(p.finOffre).toBe("2026-12-31");
  });

  it("lit une page qui n'a que de l'OpenGraph", () => {
    const p = produitDepuisHtml(PAGE_OPENGRAPH);
    expect(p.source).toBe("opengraph");
    expect(p.nom).toBe("Machine Nespresso Vertuo Pop");
    expect(p.prix).toBe(59.9);
    expect(p.prixReference).toBe(99);
    expect(p.image).toBe("https://img.marchand.fr/nespresso.jpg");
  });

  it("ne rend rien d'une page sans prix — mieux vaut rien qu'une carte creuse", () => {
    expect(produitDepuisHtml("<html><body>Bonjour</body></html>")).toBeNull();
    expect(produitDepuisHtml("")).toBeNull();
  });
});

/* Une page de rayon « promotions » telle qu'un marchand la publie : les
   articles vivent dans un ItemList, et le même produit peut apparaître
   deux fois. C'est cette page qu'on lit pour couvrir cent enseignes sans
   visiter chaque fiche une par une. */
const PAGE_RAYON = `<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "ItemList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "item": {
      "@type": "Product", "name": "Casque Sony WH-1000XM5",
      "image": "https://img.fr/a.jpg", "sku": "A1",
      "offers": { "@type": "Offer", "price": "279.99", "priceCurrency": "EUR",
                  "priceValidUntil": "2026-09-30",
                  "priceSpecification": { "@type": "UnitPriceSpecification", "priceType": "ListPrice", "price": "419.00" } } } },
    { "@type": "ListItem", "position": 2, "item": {
      "@type": "Product", "name": "Enceinte JBL Flip 6", "sku": "A2",
      "offers": { "@type": "Offer", "price": "89.99", "priceCurrency": "EUR" } } },
    { "@type": "ListItem", "position": 3, "item": {
      "@type": "Product", "name": "Article sans prix", "sku": "A3" } }
  ]
}
</script>
<script type="application/ld+json">
{ "@type": "Product", "name": "Casque Sony WH-1000XM5", "sku": "A1",
  "offers": { "@type": "Offer", "price": "279.99", "priceCurrency": "EUR" } }
</script>
</head><body></body></html>`;

describe("produitsDepuisHtml — une page de rayon", () => {
  it("rapporte tous les articles d'un ItemList", () => {
    const { produitsDepuisHtml } = require("../src/extraction.js");
    const fiches = produitsDepuisHtml(PAGE_RAYON);

    // Trois articles listés, mais l'un n'a pas de prix : il ne compte pas.
    // Et le casque apparaît deux fois — une seule fiche doit en sortir.
    expect(fiches.map((f) => f.nom)).toEqual([
      "Casque Sony WH-1000XM5",
      "Enceinte JBL Flip 6",
    ]);
    expect(fiches[0].prixReference).toBe(419);
    expect(fiches[0].finOffre).toBe("2026-09-30T00:00:00.000Z");
    expect(fiches[1].prixReference).toBeNull();
  });

  it("ne rend rien d'une page sans balisage produit", () => {
    const { produitsDepuisHtml } = require("../src/extraction.js");
    expect(produitsDepuisHtml("<html><body>rien</body></html>")).toEqual([]);
  });
});
