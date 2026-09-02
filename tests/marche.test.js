// tests/marche.test.js — L'analyse par produit, une fois le scan terminé.
//
// Ce module existe pour une raison mesurée : `lancerScan` analysait chaque
// cible SEULE, et une cible catalogue c'est soixante fiches d'un seul
// marchand. Les enseignes ne se rencontraient jamais dans un même lot, donc
// la référence « entre pairs » ne pouvait pas exister, donc la détection
// reposait entièrement sur le passé d'une seule boutique.
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const marche = require("../src/marche.js");
const produits = require("../src/produits.js");
const { db, insertSnapshots } = require("../src/db.js");

/** Un relevé, tel que la collecte en produit — identité résolue comprise. */
function relever(nom, prix, marchand, { ean = null, marque = null, url = null } = {}) {
  const produitId = produits.resoudre({ nom, ean, marque, categorie: "high-tech" });
  insertSnapshots("test", "high-tech", [
    {
      name: nom,
      price: prix,
      seller: marchand,
      url: url || `https://${marchand.toLowerCase()}.fr/p/1`,
      produitId,
      ean,
    },
  ]);
  return produitId;
}

beforeEach(() => {
  db.exec("DELETE FROM snapshots; DELETE FROM produits;");
});

describe("rencontre des marchands", () => {
  it("réunit dans un même lot des marchands que le scan analysait séparément", () => {
    // Trois enseignes, trois libellés différents, un seul code-barres.
    const ean = "4548736138049";
    relever("Casque Sony WH-1000XM5 Noir", 299, "Fnac", { ean, marque: "Sony" });
    relever("Sony WH1000XM5 casque bluetooth", 289, "Boulanger", { ean, marque: "Sony" });
    relever("SONY WH 1000 XM5 réduction de bruit", 295, "Darty", { ean, marque: "Sony" });

    const lots = marche.relevesComparables({ minMarchands: 2 });
    expect(lots).toHaveLength(1);
    expect(lots[0].offres.map((o) => o.seller).sort()).toEqual(["Boulanger", "Darty", "Fnac"]);
  });

  it("ne garde qu'un relevé par marchand — le plus récent", () => {
    const ean = "4548736138049";
    relever("Casque Sony WH-1000XM5", 350, "Fnac", { ean, marque: "Sony" });
    relever("Casque Sony WH-1000XM5", 299, "Fnac", { ean, marque: "Sony" });
    relever("Sony WH1000XM5", 289, "Boulanger", { ean, marque: "Sony" });

    const [lot] = marche.relevesComparables({ minMarchands: 2 });
    // Le marchand bavard ne pèse pas plus lourd que l'autre.
    expect(lot.offres.filter((o) => o.seller === "Fnac")).toHaveLength(1);
  });

  it("laisse de côté un produit qu'un seul marchand vend", () => {
    relever("Aspirateur Dyson V15 Detect", 549, "Darty", { marque: "Dyson" });
    relever("Aspirateur Dyson V15 Detect", 539, "Darty", { marque: "Dyson" });
    expect(marche.relevesComparables({ minMarchands: 2 })).toHaveLength(0);
  });

  it("ignore un relevé à prix nul, même s'il vient d'un second marchand", () => {
    const ean = "3401579876543";
    relever("Écran Dell U2723QE", 489, "LDLC", { ean, marque: "Dell" });
    // Écrit directement : insertSnapshots refuse aujourd'hui un prix nul, mais
    // la base garde ceux d'avant le correctif.
    const id = produits.resoudre({ nom: "Dell U2723QE", ean, marque: "Dell" });
    db.prepare(
      "INSERT INTO snapshots (query, category, name, seller, price, produit_id) VALUES (?,?,?,?,?,?)"
    ).run("test", "high-tech", "Dell U2723QE", "Rue du Commerce", 0, id);

    expect(marche.relevesComparables({ minMarchands: 2 })).toHaveLength(0);
  });
});

describe("anomalies de marché", () => {
  it("repère l'enseigne qui décroche, et nomme le marché comme référence", () => {
    const ean = "0195949038754";
    relever("Apple iPhone 15 128 Go Bleu", 809, "Fnac", { ean, marque: "Apple" });
    relever("iPhone 15 128Go bleu Apple", 799, "Darty", { ean, marque: "Apple" });
    relever("APPLE iPhone 15 - 128 Go", 819, "Boulanger", { ean, marque: "Apple" });
    // Une erreur de saisie chez le quatrième : 80,90 € au lieu de 809.
    relever("iPhone 15 128 Go", 80.9, "Rue du Commerce", { ean, marque: "Apple" });

    const { anomalies, produitsComparés } = marche.analyserMarche();
    expect(produitsComparés).toBe(1);
    expect(anomalies).toHaveLength(1);

    const [a] = anomalies;
    expect(a.seller).toBe("Rue du Commerce");
    expect(a.verdict).toBe("erreur");
    expect(a.pct).toBeGreaterThan(85);
    // Et c'est bien le MARCHÉ qui sert de référence, pas le passé d'une
    // boutique : c'est toute la différence que ce module apporte.
    expect(a.baseReference).toBe("marche");
    expect(a.marchandsComparés).toBeGreaterThanOrEqual(2);
  });

  it("ne crie pas à l'anomalie quand les marchands s'accordent", () => {
    const ean = "0195949038754";
    relever("iPhone 15 128 Go", 809, "Fnac", { ean, marque: "Apple" });
    relever("iPhone 15 128 Go", 799, "Darty", { ean, marque: "Apple" });
    relever("iPhone 15 128 Go", 789, "Boulanger", { ean, marque: "Apple" });
    expect(marche.analyserMarche().anomalies).toHaveLength(0);
  });

  it("mesure sa propre couverture plutôt que de la supposer", () => {
    const ean = "4548736138049";
    relever("Casque Sony WH-1000XM5", 299, "Fnac", { ean, marque: "Sony" });
    relever("Sony WH1000XM5", 289, "Boulanger", { ean, marque: "Sony" });
    relever("Bougie parfumée", 9.9, "Truffaut");

    const etat = marche.etatDuMarche();
    expect(etat.produitsMultiMarchands).toBe(1);
    expect(etat.couverture.avec_ean).toBe(1);
    expect(etat.releves).toBe(3);
  });
});
