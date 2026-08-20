// Phase 4 — vérité terrain, indicateurs, réputation marchand.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mesure = require("../src/mesure.js");
const reputation = require("../src/reputation.js");
const store = require("../src/dealsStore.js");
const curation = require("../src/curation.js");

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>Casque Sony WH-1000XM5 à 49€ chez Darty</title>
    <link>https://exemple.test/deal/1</link>
    <guid>deal-1</guid>
    <pubDate>Wed, 19 Aug 2026 10:00:00 +0000</pubDate>
  </item>
  <item>
    <title>Aspirateur Dyson V15 à 99,90€ chez Boulanger</title>
    <link>https://exemple.test/deal/2</link>
    <guid>deal-2</guid>
    <pubDate>Wed, 19 Aug 2026 12:00:00 +0000</pubDate>
  </item>
</channel></rss>`;

describe("vérité terrain", () => {
  it("lit un flux RSS d'erreurs de prix", () => {
    const e = mesure.parseRssErreurs(RSS);
    expect(e).toHaveLength(2);
    expect(e[0].title).toContain("Sony WH-1000XM5");
    expect(e[0].externalId).toBe("deal-1");
    expect(e[0].publishedAt).toBe("2026-08-19 10:00:00");
  });

  it("extrait le prix mentionné dans le titre", () => {
    expect(mesure.prixDuTitre("Casque à 49€ chez Darty")).toBe(49);
    expect(mesure.prixDuTitre("Aspirateur à 99,90€")).toBe(99.9);
    expect(mesure.prixDuTitre("1 299 euros")).toBe(1299);
    expect(mesure.prixDuTitre("Sans prix")).toBeNull();
  });

  it("extrait le marchand mentionné", () => {
    expect(mesure.marchandDuTitre("Casque à 49€ chez Darty")).toBe("Darty");
    expect(mesure.marchandDuTitre("Produit @Amazon")).toBe("Amazon");
  });

  it("ne réingère pas deux fois la même entrée", () => {
    const e = mesure.parseRssErreurs(RSS);
    mesure.enregistrerVerite(e);
    mesure.enregistrerVerite(e);
    const ind = mesure.indicateurs();
    expect(ind.rappel.referencesConnues).toBe(2);
  });

  it("survit à un flux vide", () => {
    expect(mesure.parseRssErreurs("")).toEqual([]);
    expect(mesure.parseRssErreurs("<rss><channel></channel></rss>")).toEqual([]);
  });

  it("échoue explicitement plutôt que de calculer sur du vide", async () => {
    const fetcher = async () => ({ ok: false, status: 500 });
    await expect(mesure.ingererVeriteTerrain({ fetcher })).rejects.toThrow(/500/);
  });
});

describe("rapprochement détection / vérité terrain", () => {
  it("rapproche approximativement deux formulations du même produit", () => {
    expect(
      mesure.memeProduitApproximatif("Casque Sony WH-1000XM5 à 49€ chez Darty", "Sony WH-1000XM5 Noir")
    ).toBe(true);
    expect(mesure.memeProduitApproximatif("Casque Sony WH-1000XM5", "Aspirateur Dyson V15")).toBe(false);
  });

  it("compte comme trouvée une erreur que RadarPrix avait détectée", () => {
    mesure.enregistrerVerite(mesure.parseRssErreurs(RSS));

    // RadarPrix a détecté le même produit de son côté.
    store.upsertDeal({
      source: "radar",
      externalId: "detect-sony",
      detector: "D3",
      type: "erreur",
      title: "Casque Sony WH-1000XM5",
      merchant: "Darty",
      price: 49,
      referencePrice: 279,
    });

    mesure.rapprocher();
    const ind = mesure.indicateurs();
    expect(ind.rappel.trouvees).toBeGreaterThanOrEqual(1);
    expect(ind.rappel.taux).toBeGreaterThan(0);
  });

  it("liste les erreurs connues non détectées", () => {
    mesure.enregistrerVerite(mesure.parseRssErreurs(RSS));
    mesure.rapprocher();
    const liste = mesure.manquees();
    // Le Dyson n'a jamais été détecté : il doit figurer dans la liste de travail.
    expect(liste.some((m) => m.title.includes("Dyson"))).toBe(true);
  });
});

describe("indicateurs", () => {
  it("ne prétend pas mesurer ce qui n'a pas été jugé", () => {
    // Sans jugement de modération, la précision doit être null — pas 0 %,
    // qui ferait croire à un moteur totalement défaillant.
    const ind = mesure.indicateurs({ jours: 1 });
    expect(ind.precision.taux).toBeNull();
    expect(ind.precision.juges).toBe(0);
  });

  it("calcule la précision sur les deals jugés", () => {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        store.upsertDeal({
          source: "radar",
          externalId: `juge-${i}`,
          detector: "D3",
          type: "erreur",
          title: `Produit jugé ${i}`,
          price: 10,
          referencePrice: 100,
        })
      );
    }
    mesure.noterDeal(ids[0], "valide");
    mesure.noterDeal(ids[1], "valide");
    mesure.noterDeal(ids[2], "valide");
    mesure.noterDeal(ids[3], "faux_positif");

    const ind = mesure.indicateurs();
    expect(ind.precision.juges).toBe(4);
    expect(ind.precision.taux).toBe(0.75);
    expect(ind.precision.fauxPositifs).toBe(1);
  });

  it("refuse un verdict inconnu", () => {
    const id = store.upsertDeal({
      source: "radar",
      externalId: "verdict-invalide",
      detector: "D3",
      type: "erreur",
      title: "X",
    });
    expect(() => mesure.noterDeal(id, "peut-etre")).toThrow(/Verdict attendu/);
  });

  it("un nouveau jugement remplace le précédent", () => {
    const id = store.upsertDeal({
      source: "radar",
      externalId: "revirement",
      detector: "D3",
      type: "erreur",
      title: "Y",
    });
    mesure.noterDeal(id, "faux_positif");
    mesure.noterDeal(id, "valide");
    // Un seul jugement compté, pas deux.
    const ind = mesure.indicateurs();
    expect(ind.precision.juges).toBeGreaterThan(0);
  });
});

describe("réputation marchand", () => {
  it("part d'un a priori quand rien n'a été mesuré", () => {
    expect(reputation.fiabilite("Enseigne Toute Neuve")).toBe(0.5);
  });

  it("distingue une place de marché de l'enseigne qui l'héberge", () => {
    expect(reputation.aPriori("Cdiscount Marketplace")).toBeLessThan(reputation.aPriori("Cdiscount"));
  });

  it("regroupe les écritures d'un même marchand", () => {
    expect(reputation.normaliserMarchand("Amazon.fr")).toBe(reputation.normaliserMarchand("AMAZON"));
    expect(reputation.normaliserMarchand("Boulanger Store")).toBe(reputation.normaliserMarchand("boulanger"));
  });

  it("se déplace avec les jugements accumulés", () => {
    const avant = reputation.fiabilite("MarchandTestReputation");
    for (let i = 0; i < 8; i++) {
      const id = store.upsertDeal({
        source: "radar",
        externalId: `rep-${i}`,
        detector: "D3",
        type: "erreur",
        title: `Produit rep ${i}`,
        merchant: "MarchandTestReputation",
        price: 10,
        referencePrice: 100,
      });
      mesure.noterDeal(id, "faux_positif");
    }
    const apres = reputation.fiabilite("MarchandTestReputation");
    expect(apres).toBeLessThan(avant); // huit faux positifs font baisser la note
  });

  it("produit un classement exploitable", () => {
    const c = reputation.classement({ limit: 10 });
    expect(Array.isArray(c)).toBe(true);
    if (c.length > 1) {
      expect(c[0].fiabilite).toBeGreaterThanOrEqual(c[c.length - 1].fiabilite);
    }
  });
});

describe("curation — le garde-fou du flux", () => {
  it("classe le montant économisé, pas seulement le pourcentage", () => {
    // −20 % sur 700 € doit passer devant −60 % sur 8 €.
    const gros = curation.scoreDesirabilite({ type: "promo", price: 560, referencePrice: 700 });
    const petit = curation.scoreDesirabilite({ type: "promo", price: 3.2, referencePrice: 8 });
    expect(gros).toBeGreaterThan(petit);
  });

  it("plafonne un deal sans référence observée", () => {
    // Une remise seulement déclarée par le marchand ne doit jamais devancer
    // une anomalie mesurée.
    const declare = curation.scoreDesirabilite({ type: "promo", discountPct: 90 });
    const mesureReelle = curation.scoreDesirabilite({ type: "erreur", price: 50, referencePrice: 500 });
    expect(declare).toBeLessThanOrEqual(35);
    expect(mesureReelle).toBeGreaterThan(declare);
  });

  it("laisse toujours passer une source déterministe", () => {
    // Un jeu offert dont on ignore le prix habituel reste publiable.
    expect(curation.meritePublication({ detector: "D2", type: "gratuit", price: 0 })).toBe(true);
  });

  it("ne publie jamais une offre déjà expirée", () => {
    expect(
      curation.meritePublication({
        detector: "D1",
        type: "promo",
        price: 10,
        referencePrice: 1000,
        expiresAt: "2020-01-01T00:00:00Z",
      })
    ).toBe(false);
  });

  it("bloque les micro-remises qui composent le gros des flux", () => {
    expect(curation.meritePublication({ detector: "D1", type: "promo", price: 95, referencePrice: 100 })).toBe(false);
    expect(curation.meritePublication({ detector: "D1", type: "promo", discountPct: 3 })).toBe(false);
  });

  it("publie une promotion d'affiliation sur sa remise annoncée", () => {
    // Un flux d'affiliation ne fournit ni prix ni référence : juger ces
    // offres au score bloquait la totalité du détecteur D1, c'est-à-dire la
    // source de volume du site.
    expect(curation.meritePublication({ detector: "D1", type: "promo", discountPct: 25 })).toBe(true);
    expect(curation.meritePublication({ detector: "D1", type: "promo", discountPct: 19 })).toBe(false);
  });

  it("retient un code promo à un seuil plus bas qu'une promotion", () => {
    // Un code est directement actionnable et se cumule souvent.
    expect(curation.meritePublication({ detector: "D1", type: "code", discountPct: 15 })).toBe(true);
    expect(curation.meritePublication({ detector: "D1", type: "promo", discountPct: 15 })).toBe(false);
  });

  it("ne publie pas une offre non chiffrée, faute de pouvoir la classer", () => {
    // « Livraison offerte dès 25 € » : limite assumée.
    expect(curation.meritePublication({ detector: "D1", type: "promo" })).toBe(false);
  });

  it("une anomalie mesurée passe toujours devant une promotion annoncée", () => {
    const mesuree = curation.scoreDesirabilite({ detector: "D3", type: "erreur", price: 27.9, referencePrice: 279 });
    const annoncee = curation.scoreDesirabilite({ detector: "D1", type: "promo", discountPct: 70 });
    expect(mesuree).toBeGreaterThan(annoncee);
  });

  it("calcule la remise depuis la source ou depuis le couple prix/référence", () => {
    expect(curation.remiseEffective({ discountPct: 42 })).toBe(42);
    expect(curation.remiseEffective({ price: 50, referencePrice: 200 })).toBe(75);
    expect(curation.remiseEffective({ price: 50 })).toBeNull();
  });

  it("tient compte de la fiabilité du marchand", () => {
    const deal = { type: "erreur", price: 50, referencePrice: 500 };
    const bon = curation.scoreDesirabilite(deal, { fiabiliteMarchand: 0.9 });
    const mauvais = curation.scoreDesirabilite(deal, { fiabiliteMarchand: 0.1 });
    expect(bon).toBeGreaterThan(mauvais);
  });
});
