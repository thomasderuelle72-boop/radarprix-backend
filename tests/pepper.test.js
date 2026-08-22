// tests/pepper.test.js — Lecture des sites bâtis sur Pepper (Dealabs…).
//
// La fixture est une page réelle réduite à quatre bons plans, prise le
// 22 août 2026. Elle protège ce qui a coûté le plus cher à découvrir : ces
// pages portent un prix de référence, que le flux RSS du même site ne
// publie jamais. Sans lui, aucune carte n'affiche de pourcentage.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { estPepper, extraireFils, offreDePepper, urlImage } = require("../src/pepper.js");

const PAGE = readFileSync(new URL("./fixtures/dealabs-accueil.html", import.meta.url), "utf8");

describe("estPepper", () => {
  it("reconnaît les sites de la plateforme, et rien d'autre", () => {
    expect(estPepper("https://www.dealabs.com/")).toBe(true);
    expect(estPepper("https://www.mydealz.de/hot")).toBe(true);
    expect(estPepper("https://www.amazon.fr/")).toBe(false);
    expect(estPepper("pas une url")).toBe(false);
  });
});

describe("extraireFils", () => {
  it("sort les bons plans d'une vraie page", () => {
    const fils = extraireFils(PAGE);
    expect(fils.length).toBe(4);
    expect(fils.every((f) => f.threadId && f.title && f.price !== undefined)).toBe(true);
  });

  it("ne rend rien d'une page sans bon plan", () => {
    expect(extraireFils("<html><body>rien</body></html>")).toEqual([]);
    expect(extraireFils("")).toEqual([]);
  });

  it("survit à un objet tronqué sans perdre les autres", () => {
    // Une page coupée en plein milieu d'un objet ne doit pas faire échouer
    // la lecture des précédents.
    const coupee = PAGE.slice(0, PAGE.length - 40);
    expect(extraireFils(coupee).length).toBeGreaterThanOrEqual(3);
  });
});

describe("offreDePepper", () => {
  const offres = extraireFils(PAGE)
    .map((f) => offreDePepper(f, { hote: "www.dealabs.com" }))
    .filter(Boolean);

  it("rend une offre exploitable pour chaque bon plan", () => {
    expect(offres.length).toBeGreaterThan(0);
    for (const o of offres) {
      expect(typeof o.name).toBe("string");
      expect(o.price).toBeGreaterThan(0);
      expect(o.externalId).toMatch(/^\d+$/);
    }
  });

  it("rapporte le prix de référence quand la source en donne un", () => {
    const avecRef = offres.filter((o) => o.refPriceAnnonce);
    expect(avecRef.length).toBeGreaterThan(0);
    // Une référence n'est retenue que si elle dépasse le prix payé :
    // l'inverse serait une remise négative.
    for (const o of avecRef) expect(o.refPriceAnnonce).toBeGreaterThan(o.price);
  });

  it("nomme le marchand et construit l'adresse de l'image", () => {
    expect(offres.some((o) => o.seller)).toBe(true);
    for (const o of offres.filter((x) => x.img)) {
      expect(o.img).toMatch(/^https:\/\/static-pepper\./);
      // Seule cette taille est servie par le serveur d'images ; les autres
      // rendent un 404, vérifié en direct.
      expect(o.img).toContain("/re/300x300/");
    }
  });

  it("écarte une offre expirée ou sans prix", () => {
    expect(offreDePepper({ threadId: "1", title: "x", price: 10, isExpired: true })).toBeNull();
    expect(offreDePepper({ threadId: "2", title: "x", price: 0 })).toBeNull();
    expect(offreDePepper({ threadId: "3", title: "x" })).toBeNull();
  });

  it("convertit la date de fin, donnée en secondes", () => {
    const o = offreDePepper({
      threadId: "9", title: "Test", price: 10,
      endDate: { timestamp: 1788472740 },
    });
    expect(o.finOffre).toBe(new Date(1788472740 * 1000).toISOString());
  });
});

describe("urlImage", () => {
  it("assemble le chemin servi par le serveur d'images", () => {
    expect(urlImage({ path: "threads/raw/DYQGq", name: "3397515_1", ext: "jpg", uid: "3397515_1.jpg" }))
      .toBe("https://static-pepper.dealabs.com/threads/raw/DYQGq/3397515_1/re/300x300/qt/70/3397515_1.jpg");
  });

  it("ne rend rien d'une image incomplète", () => {
    expect(urlImage(null)).toBeNull();
    expect(urlImage({ path: "x" })).toBeNull();
  });
});

describe("le lien d'une carte", () => {
  const offres = extraireFils(PAGE).map((f) => offreDePepper(f)).filter(Boolean);

  it("ne renvoie JAMAIS vers l'agrégateur", () => {
    // La règle qui compte le plus pour le produit : RadarPrix envoie chez
    // le marchand. Renvoyer sur la page du bon plan chez l'agrégateur
    // reviendrait à lui offrir le visiteur qu'on vient de convaincre.
    for (const o of offres) {
      if (!o.url) continue;
      expect(o.url).not.toMatch(/dealabs|mydealz|hotukdeals|pepper/i);
    }
  });

  it("envoie chez le marchand quand on sait le nommer", () => {
    const avecLien = offres.filter((o) => o.url);
    expect(avecLien.length).toBeGreaterThan(0);
    for (const o of avecLien) expect(o.url).toMatch(/^https:\/\//);
  });
});
