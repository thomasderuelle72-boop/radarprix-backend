// tests/produits.test.js — Identité produit.
//
// L'enjeu est asymétrique et il faut le garder en tête en lisant ces tests :
// un rapprochement MANQUÉ coûte une comparaison de prix ; un rapprochement
// FAUX fabrique une remise imaginaire, la publie, et fait mentir le site.
// Les cas « ne rapproche pas » comptent donc autant que les cas « rapproche ».
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const produits = require("../src/produits.js");

describe("empreinte modèle", () => {
  it("rapproche deux titres marchands du même article", () => {
    // Le cas réel : la même référence Sony, décrite par deux enseignes.
    const a = produits.empreinte("Casque Sony WH-1000XM5 Bluetooth Noir", "Sony");
    const b = produits.empreinte("Sony WH1000XM5 casque sans fil réduction de bruit", "Sony");
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it("sépare les variantes de gamme et les capacités", () => {
    const base = produits.empreinte("Apple iPhone 15 128 Go Bleu", "Apple");
    expect(base).not.toBe(produits.empreinte("iPhone 15 Pro 128 Go", "Apple"));
    expect(base).not.toBe(produits.empreinte("Apple iPhone 15 256 Go Bleu", "Apple"));
    expect(base).not.toBe(produits.empreinte("Apple iPhone 14 128 Go Bleu", "Apple"));
  });

  it("refuse une empreinte qui ne prouve rien", () => {
    // « 15 » sans marque peut être une génération, un pouce, un litre.
    expect(produits.empreinte("Écran 15 pouces")).toBeNull();
    // Aucun code modèle du tout : le titre ne distingue rien.
    expect(produits.empreinte("Pelote de laine BRIO", "DMC")).toBeNull();
    expect(produits.empreinte("Chaise en bois")).toBeNull();
  });

  it("accepte un code fort même sans marque connue", () => {
    // « u2723qe » n'appartient qu'à un article : il se suffit.
    expect(produits.empreinte("Écran Dell U2723QE 27 pouces")).toContain("u2723qe");
  });

  it("ignore une année de sortie, qui n'est pas un modèle", () => {
    expect(produits.empreinte("Tondeuse Bosch 2024", "Bosch")).toBeNull();
  });
});

describe("normalisation des identifiants", () => {
  it("n'accepte comme EAN qu'un GTIN de longueur licite", () => {
    expect(produits.eanNormalise("3401579876543")).toBe("3401579876543");
    expect(produits.eanNormalise("  3 401 579 876 543 ")).toBe("3401579876543");
    expect(produits.eanNormalise("12345")).toBeNull();
    // Un remplissage, pas un code.
    expect(produits.eanNormalise("0000000000000")).toBeNull();
    // Une référence maison n'est pas un code-barres — c'est la confusion qui
    // a vidé la colonne EAN de la base de production.
    expect(produits.eanNormalise("REF-BOULANGER-99")).toBeNull();
  });

  it("écarte une référence trop courte pour en être une", () => {
    expect(produits.referenceNormalisee("MZ-V8P1T0BW")).toBe("MZV8P1T0BW");
    expect(produits.referenceNormalisee("A1")).toBeNull();
  });
});

describe("cascade de résolution", () => {
  it("réunit deux marchands sur le même code-barres, quels que soient les titres", () => {
    const a = produits.resoudre({ nom: "Café en grains Lavazza 1 kg", ean: "8000070024007" });
    const b = produits.resoudre({ nom: "LAVAZZA Qualità Oro grains 1kg torréfaction", ean: "8000070024007" });
    expect(a).toBe(b);
  });

  it("réunit deux marchands sur marque + référence fabricant", () => {
    const a = produits.resoudre({ nom: "SSD Samsung 990 Pro 1 To", marque: "Samsung", reference: "MZ-V9P1T0BW" });
    const b = produits.resoudre({ nom: "Samsung disque SSD interne 990PRO 1To NVMe", marque: "samsung", reference: "MZV9P1T0BW" });
    expect(a).toBe(b);
  });

  it("adopte le code-barres appris plus tard sur un produit connu par empreinte", () => {
    // Premier marchand : pas d'EAN, mais un code modèle fort.
    const a = produits.resoudre({ nom: "Écran Dell U4025QW 40 pouces", marque: "Dell" });
    expect(produits.produit(a).ean).toBeNull();
    // Second marchand : même modèle, et lui publie le code-barres.
    const b = produits.resoudre({ nom: "Dell U4025QW moniteur incurvé", marque: "Dell", ean: "5397184831182" });
    expect(b).toBe(a);
    // Le produit devient rapprochable avec n'importe qui d'autre le publiant.
    expect(produits.produit(a).ean).toBe("5397184831182");
    const c = produits.resoudre({ nom: "Moniteur 40\" Dell, tout autre libellé", ean: "5397184831182" });
    expect(c).toBe(a);
  });

  it("ne fusionne pas deux articles voisins qui portent des codes différents", () => {
    const a = produits.resoudre({ nom: "Manette Xbox Series X sans fil", marque: "Microsoft", ean: "889842612790" });
    const b = produits.resoudre({ nom: "Manette Xbox Series X sans fil", marque: "Microsoft", ean: "889842713916" });
    expect(a).not.toBe(b);
  });

  it("garde une identité locale quand rien ne permet de rapprocher", () => {
    const a = produits.resoudre({ nom: "Bouquet de fleurs séchées" });
    const b = produits.resoudre({ nom: "Bouquet de fleurs séchées" });
    const c = produits.resoudre({ nom: "Bougie parfumée vanille" });
    // Le même titre garde le même historique…
    expect(a).toBe(b);
    // …mais rien ne prétend que deux titres différents sont un seul article.
    expect(a).not.toBe(c);
    expect(produits.forceIdentite(produits.produit(a))).toBe("titre");
  });

  it("dit sur quoi repose chaque identité", () => {
    const parEan = produits.resoudre({ nom: "Thé vert bio 100 g", ean: "3596710412341" });
    expect(produits.forceIdentite(produits.produit(parEan))).toBe("ean");
    const parEmp = produits.resoudre({ nom: "Clavier Logitech MX Keys S", marque: "Logitech", reference: "920-011561" });
    expect(["reference", "empreinte"]).toContain(produits.forceIdentite(produits.produit(parEmp)));
  });
});
