// Détecteur D3 — assainissement de la détection d'anomalies (phase 2).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const algo = require("../src/algorithm.js");
const { productKey, significantWords } = require("../src/productKey.js");
const { insertSnapshots } = require("../src/db.js");

describe("séparation des variantes (constat F2)", () => {
  // Les cinq collisions constatées sur le code d'origine : chacune produisait
  // un « deal » qui n'existait pas, la médiane du groupe étant tirée vers le
  // haut par les variantes premium.
  const collisionsHistoriques = [
    ["Carte graphique RTX 4060", "Carte graphique RTX 4060 Ti"],
    ["iPhone 15 128 Go", "iPhone 15 Pro 128 Go"],
    ["Samsung Galaxy S24", "Samsung Galaxy S24 Ultra"],
    ["Nike Air Max 90", "Nike Air Max 90 Femme"],
    ["PlayStation 5 Slim", "PlayStation 5 Slim Digital"],
  ];

  it.each(collisionsHistoriques)("ne confond plus %s avec %s", (base, variante) => {
    expect(algo.sameProduct(base, variante)).toBe(false);
  });

  it("conserve les suffixes de gamme de deux lettres", () => {
    // "ti" et "se" étaient supprimés par le filtre de longueur : c'est là que
    // la confusion prenait sa source.
    expect(significantWords("RTX 4060 Ti")).toContain("ti");
    expect(significantWords("Apple Watch SE")).toContain("se");
    expect(productKey("RTX 4060")).not.toBe(productKey("RTX 4060 Ti"));
  });

  it("regroupe toujours le même produit formulé différemment", () => {
    expect(algo.sameProduct("Apple AirPods Pro 2 USB-C", "AirPods Pro 2e génération USB-C Apple")).toBe(true);
    expect(algo.sameProduct("PS5 Slim", "PlayStation 5 Slim")).toBe(true);
  });

  it("sépare les variantes en groupes distincts", () => {
    const offres = [
      { name: "RTX 4060", price: 300 },
      { name: "RTX 4060", price: 310 },
      { name: "RTX 4060 Ti", price: 450 },
      { name: "RTX 4060 Ti", price: 460 },
    ];
    const groupes = algo.clusterByProduct(offres);
    expect(groupes).toHaveLength(2);
    expect(groupes.every((g) => g.length === 2)).toBe(true);
  });

  it("laisse une variante rester pertinente pour une recherche large", () => {
    // La 4060 Ti répond bien à une recherche « RTX 4060 » : elle doit
    // apparaître, simplement comparée à ses propres pairs.
    expect(algo.titleMatchesQuery("Carte graphique RTX 4060 Ti", "RTX 4060")).toBe(true);
  });
});

describe("places de marché (constat F7)", () => {
  it("ne prend plus une place de marché pour l'enseigne qui l'héberge", () => {
    for (const s of ["Cdiscount Marketplace", "Amazon Marketplace", "Fnac Marketplace", "Vendu par TopDealz sur Rakuten"]) {
      expect(algo.isTrustedSeller(s)).toBe(false);
      expect(algo.isMarketplaceSeller(s)).toBe(true);
    }
  });

  it("reconnaît toujours les enseignes vendant en leur nom propre", () => {
    for (const s of ["Amazon.fr", "Darty", "Boulanger", "LDLC"]) {
      expect(algo.isTrustedSeller(s)).toBe(true);
    }
  });

  it("traite un vendeur inconnu comme ni sûr ni place de marché", () => {
    expect(algo.isTrustedSeller("Boutique Inconnue")).toBe(false);
    expect(algo.isMarketplaceSeller("Boutique Inconnue")).toBe(false);
  });
});

describe("frais de port (constat F8)", () => {
  it("compare le prix livré, pas le prix affiché", () => {
    expect(algo.prixTotal({ price: 200, delivery: 40 })).toBe(240);
    expect(algo.prixTotal({ price: 220, delivery: 0 })).toBe(220);
    expect(algo.prixTotal({ price: 100 })).toBe(100); // livraison inconnue
  });
});

describe("état de l'article", () => {
  it("lit le champ structuré, pas seulement le titre", () => {
    // Le cas qui traversait le filtre : titre neutre, état dans le champ.
    const offre = { name: "iPhone 15 128 Go Bleu", itemCondition: "reconditionne" };
    expect(algo.isUsedOrRefurbishedTitle(offre.name)).toBe(false); // titre muet
    expect(algo.estReconditionne(offre)).toBe(true); // mais bien détecté
  });

  it("continue de reconnaître l'état annoncé dans le titre", () => {
    expect(algo.estReconditionne({ name: "iPhone 14 reconditionné grade A" })).toBe(true);
  });
});

describe("dispersion et référence", () => {
  it("le MAD s'adapte à la dispersion du marché", () => {
    const serre = [498, 500, 502, 505, 499];
    const disperse = [90, 140, 200, 260, 300];
    expect(algo.madNormalise(serre)).toBeLessThan(algo.madNormalise(disperse));
  });

  it("juge anormal un écart modeste sur un marché serré", () => {
    // Le cas que le seuil en pourcentage fixe manquait complètement.
    const prix = [498, 500, 502, 505, 499];
    const mad = algo.madNormalise(prix);
    const z = (500 - 390) / mad;
    expect(z).toBeGreaterThan(6); // très au-delà du seuil « erreur »
  });

  it("juge normal un gros écart sur un marché dispersé", () => {
    const prix = [90, 140, 200, 260, 300];
    const mad = algo.madNormalise(prix);
    const z = (200 - 80) / mad;
    expect(z).toBeLessThan(3.5); // sous le seuil « deal » malgré −60 %
  });

  it("combine les références au lieu d'en laisser une écraser l'autre", () => {
    const r = algo.combinerReferences({ valeur: 100, poids: 1 }, { valeur: 200, poids: 3 });
    expect(r).toBe(175); // (100·1 + 200·3) / 4

    // Une seule référence disponible : renvoyée telle quelle.
    expect(algo.combinerReferences({ valeur: 100, poids: 2 }, { valeur: null, poids: 0 })).toBe(100);
    expect(algo.combinerReferences(null, null)).toBeNull();
  });

  it("la médiane pondérée privilégie les prix récents", () => {
    const points = [
      { prix: 100, poids: 1 }, // récent
      { prix: 500, poids: 0.01 }, // très ancien
      { prix: 490, poids: 0.01 },
    ];
    expect(algo.medianePonderee(points)).toBe(100);
  });

  it("un marchand bavard ne pèse pas plus lourd que les autres", () => {
    const maintenant = new Date("2026-08-20T12:00:00Z");
    const recent = "2026-08-20 10:00:00";
    const lignes = [
      // Un marchand qui publie dix lignes à 100 €…
      ...Array.from({ length: 10 }, () => ({ price: 100, seller: "Bavard", scraped_at: recent })),
      // …ne doit pas écraser deux marchands cohérents à 500 €.
      { price: 500, seller: "A", scraped_at: recent },
      { price: 510, seller: "B", scraped_at: recent },
    ];
    // Médiane des médianes marchands : [100, 500, 510] → 500.
    expect(algo.referenceHistorique(lignes, maintenant).valeur).toBe(500);
    // Le nombre de marchands remonte avec la valeur : c'est lui qui distingue
    // un prix de marché du passé d'une seule enseigne.
    expect(algo.referenceHistorique(lignes, maintenant).marchands).toBe(3);
  });

  it("un prix ancien pèse moins qu'un prix récent", () => {
    const maintenant = new Date("2026-08-20T12:00:00Z");
    const lignes = [
      { price: 900, seller: "A", scraped_at: "2026-05-01 12:00:00" }, // ~3,5 mois
      { price: 900, seller: "A", scraped_at: "2026-05-02 12:00:00" },
      { price: 400, seller: "A", scraped_at: "2026-08-20 08:00:00" }, // ce matin
    ];
    // Sans pondération, la moyenne donnerait ~733 € et fabriquerait un faux
    // « deal » sur toute offre autour de 400 €.
    expect(algo.referenceHistorique(lignes, maintenant).valeur).toBe(400);
  });
});

describe("analyzeOffers de bout en bout", () => {
  it("ne signale pas d'anomalie sur un marché cohérent", () => {
    const offres = [
      { name: "Clavier Mecanique ABC", price: 79, seller: "Amazon.fr" },
      { name: "Clavier Mecanique ABC", price: 82, seller: "Fnac" },
      { name: "Clavier Mecanique ABC", price: 75, seller: "LDLC" },
      { name: "Clavier Mecanique ABC", price: 80, seller: "Darty" },
    ];
    expect(algo.analyzeOffers(offres).every((o) => o.verdict === "normal")).toBe(true);
  });

  it("détecte une virgule décalée dès le premier scan", () => {
    const offres = [
      { name: "Casque Gaming XYZ", price: 449, seller: "Fnac" },
      { name: "Casque Gaming XYZ", price: 439, seller: "Boulanger" },
      { name: "Casque Gaming XYZ", price: 44.9, seller: "Boutique Inconnue" },
      { name: "Casque Gaming XYZ", price: 459, seller: "Amazon.fr" },
    ];
    const suspect = algo.analyzeOffers(offres).find((o) => o.price === 44.9);
    expect(suspect.verdict).toBe("erreur");
  });

  it("ne fabrique plus de faux deal entre une 4060 et une 4060 Ti", () => {
    // Avant le correctif : médiane commune ~380 €, la 4060 à 300 € sortait
    // en « deal » à −21 % et la Ti à 460 € semblait normale.
    const offres = [
      { name: "RTX 4060", price: 300, seller: "LDLC" },
      { name: "RTX 4060", price: 305, seller: "Amazon.fr" },
      { name: "RTX 4060 Ti", price: 450, seller: "Fnac" },
      { name: "RTX 4060 Ti", price: 460, seller: "Darty" },
    ];
    expect(algo.analyzeOffers(offres).every((o) => o.verdict === "normal")).toBe(true);
  });

  it("exclut le reconditionné du calcul de la référence du neuf", () => {
    const offres = [
      { name: "Tablette QRS 128", price: 500, seller: "Fnac" },
      { name: "Tablette QRS 128", price: 510, seller: "Darty" },
      { name: "Tablette QRS 128", price: 495, seller: "Amazon.fr" },
      // Reconditionnée à 250 € : légitime, mais ne doit ni abaisser la
      // référence ni ressortir comme une erreur de prix.
      { name: "Tablette QRS 128", price: 250, seller: "Back Market", itemCondition: "reconditionne" },
    ];
    const res = algo.analyzeOffers(offres);
    const neuf = res.find((o) => o.seller === "Fnac");
    expect(neuf.refPrice).toBeGreaterThan(450); // référence non contaminée
  });

  it("compte les frais de port dans le verdict", () => {
    const offres = [
      { name: "Enceinte KLM 300", price: 200, seller: "Fnac", delivery: 0 },
      { name: "Enceinte KLM 300", price: 205, seller: "Darty", delivery: 0 },
      { name: "Enceinte KLM 300", price: 198, seller: "Amazon.fr", delivery: 0 },
      // Affiché 120 € mais 95 € de port : 215 € livrés, donc rien d'anormal.
      { name: "Enceinte KLM 300", price: 120, seller: "Boutique Inconnue", delivery: 95 },
    ];
    const piege = algo.analyzeOffers(offres).find((o) => o.price === 120);
    expect(piege.priceTotal).toBe(215);
    expect(piege.verdict).toBe("normal");
  });

  it("s'appuie sur l'historique quand il existe", () => {
    const nom = "Moniteur Test Historique 27";
    for (let i = 0; i < 6; i++) {
      insertSnapshots("moniteur test historique 27", "hightech", [
        { name: nom, price: 300 + i, seller: `Marchand${i}` },
      ]);
    }
    const [res] = algo.analyzeOffers([{ name: nom, price: 90, seller: "Amazon.fr" }]);
    expect(res.refPrice).toBeGreaterThan(280);
    expect(res.verdict).toBe("erreur");
  });

  it("renvoie un z-score exploitable quand la dispersion est mesurable", () => {
    const offres = [
      { name: "Sac Test ZED", price: 100, seller: "Fnac" },
      { name: "Sac Test ZED", price: 101, seller: "Darty" },
      { name: "Sac Test ZED", price: 99, seller: "Amazon.fr" },
      { name: "Sac Test ZED", price: 102, seller: "LDLC" },
      { name: "Sac Test ZED", price: 60, seller: "Boutique Inconnue" },
    ];
    const bas = algo.analyzeOffers(offres).find((o) => o.price === 60);
    expect(bas.zScore).toBeGreaterThan(3.5);
  });
});

/* ── Fausses remises fabriquées par l'historique ─────────────────────
   Constaté en production le 23 août 2026 : le site publiait « Casque
   gaming TRUST ZIROX 15,98 € au lieu de 48 € (−67 %) » sur un casque
   vendu 15 à 18 € partout en France. La page marchande ne contenait
   aucun 48 ; le prix payé, lui, était exact.

   Deux causes cumulées, corrigées ensemble :
     · le lot s'enregistrait AVANT d'être analysé, donc se comparait à
       lui-même ;
     · pour compenser, l'analyse écartait de l'historique toute ligne au
       prix du jour — ne laissant que les lectures aberrantes. */
describe("l'historique ne doit pas fabriquer de remise", () => {
  const jour = (d) => new Date(Date.now() - d * 86400000).toISOString().replace("T", " ").slice(0, 19);

  it("une lecture aberrante isolée ne devient pas la référence", () => {
    const lignes = [];
    // Prix stable, relevé huit fois par jour pendant dix jours.
    for (let d = 1; d <= 10; d++) {
      for (let k = 0; k < 8; k++) lignes.push({ price: 15.98, seller: "Electro Dépôt", scraped_at: jour(d) });
    }
    // Une seule lecture fautive, au milieu.
    lignes.push({ price: 48, seller: "Electro Dépôt", scraped_at: jour(6) });

    const ref = algo.referenceHistorique(lignes, new Date());
    expect(ref.valeur).toBeCloseTo(15.98, 2);
    expect(ref.marchands).toBe(1);
  });

  it("dit combien de marchands soutiennent la référence", () => {
    const unSeul = [
      { price: 100, seller: "Boulanger", scraped_at: jour(1) },
      { price: 110, seller: "Boulanger", scraped_at: jour(2) },
    ];
    expect(algo.referenceHistorique(unSeul, new Date()).marchands).toBe(1);

    const plusieurs = [
      ...unSeul,
      { price: 105, seller: "Darty", scraped_at: jour(1) },
      { price: 108, seller: "Fnac", scraped_at: jour(2) },
    ];
    expect(algo.referenceHistorique(plusieurs, new Date()).marchands).toBe(3);
  });

  it("distingue un prix de marché du passé d'une seule enseigne", () => {
    // Un seul marchand, un seul produit : aucune comparaison possible.
    const seul = algo.analyzeOffers([{ name: "Casque gaming TRUST ZIROX", price: 15.98, seller: "Electro Dépôt" }]);
    expect(seul[0].refPrice).toBeNull();
    expect(seul[0].verdict).toBe("normal");

    // Trois marchands pour le même produit : la référence devient un prix
    // de marché, et l'écart se mesure enfin contre quelque chose de réel.
    const compare = algo.analyzeOffers([
      { name: "Casque Sony WH-1000XM5", price: 180, seller: "Boulanger" },
      { name: "Casque Sony WH-1000XM5", price: 380, seller: "Darty" },
      { name: "Casque Sony WH-1000XM5", price: 390, seller: "Fnac" },
    ]);
    const affaire = compare.find((o) => o.seller === "Boulanger");
    expect(affaire.baseReference).toBe("marche");
    expect(affaire.marchandsComparés).toBeGreaterThanOrEqual(2);
    expect(affaire.pct).toBeGreaterThan(40);
  });
});
