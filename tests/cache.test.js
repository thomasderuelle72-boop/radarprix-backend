// tests/cache.test.js — Mémoire courte devant les lectures publiques.
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cache = require("../src/cache.js");

beforeEach(() => cache.invalider());

describe("mémorisation", () => {
  it("ne calcule qu'une fois pendant la durée de vie", () => {
    let appels = 0;
    const calcul = () => ++appels;
    expect(cache.memo("k", calcul)).toBe(1);
    expect(cache.memo("k", calcul)).toBe(1);
    expect(appels).toBe(1);
  });

  it("distingue deux clés", () => {
    expect(cache.memo("a", () => "A")).toBe("A");
    expect(cache.memo("b", () => "B")).toBe("B");
  });

  it("recalcule après expiration", async () => {
    let appels = 0;
    expect(cache.memo("court", () => ++appels, 1)).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(cache.memo("court", () => ++appels, 1)).toBe(2);
  });

  it("oublie tout quand les données changent", () => {
    let appels = 0;
    cache.memo("k", () => ++appels);
    cache.invalider();
    cache.memo("k", () => ++appels);
    // L'invalidation se fait par génération : les anciennes clés deviennent
    // inatteignables plutôt que d'être cherchées une par une.
    expect(appels).toBe(2);
  });

  it("ne grossit pas sans fin", () => {
    // Une API paginée et filtrable fabrique une clé par combinaison : sans
    // plafond, le cache serait une fuite de mémoire lente.
    for (let i = 0; i < cache.MAX_ENTREES + 50; i++) cache.memo(`k${i}`, () => i);
    expect(cache.etat().entrees).toBeLessThanOrEqual(cache.MAX_ENTREES);
  });
});

describe("étiquette de réponse", () => {
  it("est stable pour un même contenu et change avec lui", () => {
    const a = { items: [1, 2, 3] };
    expect(cache.etiquette(a)).toBe(cache.etiquette({ items: [1, 2, 3] }));
    expect(cache.etiquette(a)).not.toBe(cache.etiquette({ items: [1, 2, 4] }));
  });

  it("répond 304 sans corps quand le client a déjà la réponse", () => {
    const charge = { items: [] };
    const tag = cache.etiquette(charge);
    let statut = 200;
    let corps = null;
    const res = {
      set: () => res,
      status: (c) => {
        statut = c;
        return res;
      },
      end: () => res,
      json: (v) => {
        corps = v;
        return res;
      },
    };
    cache.servir({ headers: { "if-none-match": tag } }, res, charge);
    expect(statut).toBe(304);
    expect(corps).toBeNull();
  });
});
