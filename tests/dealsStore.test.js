// Modèle de données commun aux quatre détecteurs.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const store = require("../src/dealsStore.js");

/** Deal minimal valide, que chaque test spécialise. */
function dealDe(over = {}) {
  return {
    source: "test",
    externalId: "x1",
    detector: "D1",
    type: "promo",
    title: "Aspirateur Dyson V15",
    ...over,
  };
}

describe("validation", () => {
  it("refuse un type de deal inconnu", () => {
    expect(() => store.upsertDeal(dealDe({ type: "soldes" }))).toThrow(/Type de deal inconnu/);
  });

  it("refuse un détecteur inconnu", () => {
    expect(() => store.upsertDeal(dealDe({ detector: "D9" }))).toThrow(/Détecteur inconnu/);
  });

  it("refuse un état inconnu", () => {
    expect(() => store.upsertDeal(dealDe({ itemCondition: "casse" }))).toThrow(/État inconnu/);
  });

  it("exige source, identifiant externe et titre", () => {
    expect(() => store.upsertDeal(dealDe({ externalId: null }))).toThrow(/identifiant externe/);
    expect(() => store.upsertDeal(dealDe({ title: "" }))).toThrow(/titre/);
  });
});

describe("idempotence", () => {
  it("réingérer le même flux ne duplique pas les lignes", () => {
    const d = dealDe({ externalId: "idem-1", price: 100, referencePrice: 200 });
    const id1 = store.upsertDeal(d);
    const id2 = store.upsertDeal(d);
    const id3 = store.upsertDeal({ ...d, title: "Titre corrigé" });

    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
    expect(store.getDeal(id1).title).toBe("Titre corrigé");
  });

  it("deux sources peuvent porter le même identifiant externe", () => {
    const a = store.upsertDeal(dealDe({ source: "awin", externalId: "collision" }));
    const b = store.upsertDeal(dealDe({ source: "strackr", externalId: "collision" }));
    expect(a).not.toBe(b);
  });
});

describe("remise", () => {
  it("se calcule depuis la référence observée quand elle n'est pas fournie", () => {
    const id = store.upsertDeal(dealDe({ externalId: "pct-1", price: 60, referencePrice: 200 }));
    expect(store.getDeal(id).discountPct).toBe(70);
  });

  it("reste nulle sans référence — jamais de remise inventée", () => {
    const id = store.upsertDeal(dealDe({ externalId: "pct-2", price: 60 }));
    expect(store.getDeal(id).discountPct).toBeNull();
  });
});

describe("types non tarifaires", () => {
  it("stocke un code promo, que l'ancien modèle ne savait pas représenter", () => {
    const id = store.upsertDeal(
      dealDe({ externalId: "code-1", type: "code", voucherCode: "BIENVENUE20", price: null })
    );
    const d = store.getDeal(id);
    expect(d.type).toBe("code");
    expect(d.voucherCode).toBe("BIENVENUE20");
    expect(d.price).toBeNull();
  });

  it("stocke un produit gratuit à prix zéro", () => {
    const id = store.upsertDeal(
      dealDe({ externalId: "free-1", detector: "D2", type: "gratuit", price: 0, referencePrice: 19.99 })
    );
    const d = store.getDeal(id);
    expect(d.price).toBe(0);
    expect(d.discountPct).toBe(100);
  });

  it("stocke une offre de remboursement sans variation de prix", () => {
    const id = store.upsertDeal(dealDe({ externalId: "odr-1", type: "odr", price: 299 }));
    expect(store.getDeal(id).type).toBe("odr");
  });
});

describe("flux public", () => {
  it("ne sert que les deals publiés", () => {
    store.upsertDeal(dealDe({ externalId: "pub-cache" }));
    const visible = store.upsertDeal(dealDe({ externalId: "pub-visible" }));
    store.publierDeal(visible);

    const ids = store.listDeals({ page: 1, pageSize: 50 }).items.map((d) => d.id);
    expect(ids).toContain(visible);
    expect(ids).toHaveLength(1);
  });

  it("masque une offre expirée", () => {
    const id = store.upsertDeal(dealDe({ externalId: "exp-1", expiresAt: "2020-01-01 00:00:00" }));
    store.publierDeal(id);
    const ids = store.listDeals({ pageSize: 50 }).items.map((d) => d.id);
    expect(ids).not.toContain(id);
  });

  it("masque une offre retirée de son flux", () => {
    const id = store.upsertDeal(dealDe({ source: "flux-a", externalId: "toujours-la" }));
    const parti = store.upsertDeal(dealDe({ source: "flux-a", externalId: "disparu" }));
    store.publierDeal(id);
    store.publierDeal(parti);

    store.markMissingAsRemoved("flux-a", ["toujours-la"]);

    const ids = store.listDeals({ pageSize: 50 }).items.map((d) => d.id);
    expect(ids).toContain(id);
    expect(ids).not.toContain(parti);
  });

  it("ne retire rien si le flux répond vide — une panne ne doit pas vider le site", () => {
    const id = store.upsertDeal(dealDe({ source: "flux-b", externalId: "survivant" }));
    store.publierDeal(id);

    expect(store.markMissingAsRemoved("flux-b", [])).toBe(0);
    expect(store.listDeals({ pageSize: 50 }).items.map((d) => d.id)).toContain(id);
  });

  it("réapparaître dans le flux annule le retrait", () => {
    const d = dealDe({ source: "flux-c", externalId: "revenu" });
    const id = store.upsertDeal(d);
    store.publierDeal(id);
    store.markMissingAsRemoved("flux-c", ["autre-chose"]);
    expect(store.listDeals({ pageSize: 50 }).items.map((x) => x.id)).not.toContain(id);

    store.upsertDeal(d); // le marchand a remis la promo en ligne
    expect(store.listDeals({ pageSize: 50 }).items.map((x) => x.id)).toContain(id);
  });

  it("sépare le reconditionné du flux principal", () => {
    const neuf = store.upsertDeal(dealDe({ source: "etat", externalId: "neuf-1" }));
    const reco = store.upsertDeal(
      dealDe({ source: "etat", externalId: "reco-1", detector: "D4", type: "occasion", itemCondition: "reconditionne" })
    );
    store.publierDeal(neuf);
    store.publierDeal(reco);

    const principal = store.listDeals({ pageSize: 50 }).items.map((d) => d.id);
    expect(principal).toContain(neuf);
    expect(principal).not.toContain(reco);

    const occasion = store.listDeals({ itemCondition: "reconditionne", pageSize: 50 }).items.map((d) => d.id);
    expect(occasion).toContain(reco);
    expect(occasion).not.toContain(neuf);
  });

  it("classe par score décroissant", () => {
    for (const [ext, score] of [["s-1", 10], ["s-2", 90], ["s-3", 50]]) {
      const id = store.upsertDeal(dealDe({ source: "tri", externalId: ext, score }));
      store.publierDeal(id);
    }
    const scores = store.listDeals({ pageSize: 50 }).items.map((d) => d.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
