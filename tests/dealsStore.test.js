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

/* La même serrure Nuki s'affichait deux fois sur l'accueil — une carte
   Amazon, une carte Boulanger, au même prix — sans que rien ne dise qu'il
   s'agissait du même article. Le regroupement par clé produit répare ça. */
describe("regroupement par produit", () => {
  it("rattache les autres marchands du même article", () => {
    const a = store.upsertDeal(
      dealDe({ source: "grp", externalId: "nuki-amazon", title: "Serrure connectée Nuki Smart Lock Ultra", merchant: "Amazon", price: 299.99 })
    );
    const b = store.upsertDeal(
      dealDe({ source: "grp", externalId: "nuki-boulanger", title: "Serrure connectée Nuki smart lock Ultra - Cy", merchant: "Boulanger", price: 289 })
    );
    store.publierDeal(a);
    store.publierDeal(b);

    const items = store.listDeals({ pageSize: 50 }).items;
    // Un produit, une carte : c'est la moins chère qui reste.
    expect(items.find((d) => d.id === a)).toBeUndefined();

    const cote = items.find((d) => d.id === b);
    expect(cote.autresMarchands.map((m) => m.marchand)).toEqual(["Amazon"]);
    expect(cote.meilleurPrix).toBe(289);
    expect(cote.nbMarchands).toBe(2);
  });

  it("rapproche deux marchands qui n'emploient pas les mêmes mots", () => {
    // Le cas vu en production : la clé stricte diffère de « cylindre » et
    // « universel », et la comparaison n'avait donc jamais lieu.
    const a = store.upsertDeal(
      dealDe({ source: "res", externalId: "n-a", title: "Serrure connectée Somfy Keytis Origin", merchant: "Amazon", price: 299.99 })
    );
    const b = store.upsertDeal(
      dealDe({ source: "res", externalId: "n-b", title: "Serrure connectée Somfy Keytis Origin - Cylindre universel", merchant: "Boulanger", price: 299.99 })
    );
    store.publierDeal(a);
    store.publierDeal(b);

    const items = store.listDeals({ pageSize: 50 }).items;
    // Prix égal : c'est la plus ancienne qui reste, pour que l'ordre ne
    // danse pas d'un rafraîchissement à l'autre.
    expect(items.find((d) => d.id === b)).toBeUndefined();
    const cote = items.find((d) => d.id === a);
    expect(cote.autresMarchands.map((m) => m.marchand)).toEqual(["Boulanger"]);
    expect(cote.nbMarchands).toBe(2);
  });

  it("ne confond pas deux générations ni deux gammes", () => {
    const base = store.upsertDeal(
      dealDe({ source: "gamme", externalId: "g-base", title: "Carte graphique Asus GeForce RTX 4060", merchant: "LDLC", price: 320 })
    );
    const ti = store.upsertDeal(
      dealDe({ source: "gamme", externalId: "g-ti", title: "Carte graphique Asus GeForce RTX 4060 Ti", merchant: "Materiel", price: 360 })
    );
    store.publierDeal(base);
    store.publierDeal(ti);

    const cote = store.listDeals({ pageSize: 50 }).items.find((d) => d.id === base);
    expect(cote.autresMarchands).toEqual([]);
  });

  it("s'abstient quand l'écart de prix trahit une variante non dite", () => {
    // Deux titres ressemblants mais un prix du simple au double : c'est un
    // pack ou une autre finition, pas une aubaine.
    const nu = store.upsertDeal(
      dealDe({ source: "pack", externalId: "p-nu", title: "Aspirateur balai Dyson Detect Absolute", merchant: "Darty", price: 599 })
    );
    const pack = store.upsertDeal(
      dealDe({ source: "pack", externalId: "p-pack", title: "Aspirateur balai Dyson Detect Absolute Submarine", merchant: "Boulanger", price: 899 })
    );
    store.publierDeal(nu);
    store.publierDeal(pack);

    const cote = store.listDeals({ pageSize: 50 }).items.find((d) => d.id === nu);
    expect(cote.autresMarchands).toEqual([]);
  });

  it("ne rattache pas deux articles différents", () => {
    const id = store.upsertDeal(
      dealDe({ source: "grp2", externalId: "seul", title: "Cafetière Delonghi Magnifica", merchant: "Darty", price: 399 })
    );
    store.publierDeal(id);
    const seul = store.listDeals({ pageSize: 50 }).items.find((d) => d.id === id);
    expect(seul.autresMarchands).toEqual([]);
    expect(seul.meilleurPrix).toBe(399);
  });

  it("ne montre un marchand qu'une fois, à son meilleur prix", () => {
    const ref = store.upsertDeal(dealDe({ source: "uniq", externalId: "u-ref", title: "Enceinte portable Marshall Emberton", merchant: "Fnac", price: 129 }));
    const d1 = store.upsertDeal(dealDe({ source: "uniq", externalId: "u-1", title: "Enceinte portable Marshall Emberton", merchant: "Darty", price: 125 }));
    const d2 = store.upsertDeal(dealDe({ source: "uniq", externalId: "u-2", title: "Enceinte portable Marshall Emberton - Noir", merchant: "Darty", price: 135 }));
    [ref, d1, d2].forEach(store.publierDeal);

    const items = store.listDeals({ pageSize: 50 }).items;
    // Darty à 125 € est la moins chère des trois : c'est elle qui reste.
    expect(items.map((d) => d.id)).not.toContain(ref);
    expect(items.map((d) => d.id)).not.toContain(d2);

    const cote = items.find((d) => d.id === d1);
    expect(cote.autresMarchands).toEqual([expect.objectContaining({ marchand: "Fnac", prix: 129 })]);
    expect(cote.nbMarchands).toBe(2);
  });

  it("ignore le même marchand publié deux fois", () => {
    const a = store.upsertDeal(dealDe({ source: "grp3", externalId: "dup-a", title: "Casque Bose QuietComfort Ultra", merchant: "Fnac", price: 349 }));
    const b = store.upsertDeal(dealDe({ source: "grp3", externalId: "dup-b", title: "Casque Bose QuietComfort ultra", merchant: "Fnac", price: 359 }));
    store.publierDeal(a);
    store.publierDeal(b);

    const items = store.listDeals({ pageSize: 50 }).items;
    const cote = items.find((d) => d.id === a);
    expect(cote.autresMarchands).toEqual([]);
    expect(cote.nbMarchands).toBe(1);
    // Deux annonces du même vendeur pour le même casque : une seule carte.
    expect(items.map((d) => d.id)).not.toContain(b);
  });
});

/* La nature d'une offre doit pouvoir se corriger. Une promotion publiée
   avant qu'on sache extraire son code restait « promo » à vie, alors que la
   source disait ensuite « code » : la page des codes promo restait vide
   pendant que les codes s'affichaient ailleurs. */
describe("une offre revue corrige sa nature", () => {
  it("met à jour le type et la clé produit", () => {
    const d = dealDe({ source: "maj", externalId: "u-1", type: "promo", title: "Offre du moment" });
    const id = store.upsertDeal(d);
    store.publierDeal(id);

    store.upsertDeal({ ...d, type: "code", title: "Casque Bose QuietComfort Ultra" });
    const ligne = store.listDeals({ pageSize: 50, includeUnpublished: true }).items.find((x) => x.id === id);
    expect(ligne.type).toBe("code");
    expect(ligne.title).toBe("Casque Bose QuietComfort Ultra");
  });
});

/* Le filtre de dernier recours. La collecte ne peut plus produire de prix
   nul, mais la table `deals` garde ce qui y a déjà été publié : sans ce
   filtre, il aurait fallu attendre le scan suivant pour cesser d'annoncer
   cinquante et une pelotes de laine offertes. */
describe("une offre à 0 € ne sort pas du flux", () => {
  it("masque un prix nul, garde le gratuit, tolère un prix inconnu", () => {
    const zero = store.upsertDeal(
      dealDe({ externalId: "zero", type: "erreur", title: "Pelote de laine BRIO", price: 0 })
    );
    const gratuit = store.upsertDeal(
      dealDe({ externalId: "epic", type: "gratuit", title: "Jeu offert cette semaine", price: 0 })
    );
    const inconnu = store.upsertDeal(
      dealDe({ externalId: "odr", type: "odr", title: "50 € remboursés", price: null })
    );
    const normal = store.upsertDeal(
      dealDe({ externalId: "ok", type: "promo", title: "Aspirateur Dyson V15", price: 349 })
    );
    for (const id of [zero, gratuit, inconnu, normal]) store.publierDeal(id);

    const publies = store.listDeals({ pageSize: 50 }).items.map((d) => d.id);
    expect(publies).not.toContain(zero);
    // Zéro est le sujet même d'une offre gratuite : Epic ne s'est pas trompé.
    expect(publies).toContain(gratuit);
    // Un code promo ou une ODR n'annoncent pas toujours un montant.
    expect(publies).toContain(inconnu);
    expect(publies).toContain(normal);
  });

  it("purge ce qui a déjà été publié à un prix nul, sans toucher au gratuit", () => {
    const bilan = store.purgerPrixInvalides();
    expect(bilan.deals).toBeGreaterThanOrEqual(1);
    const restants = store.listDeals({ pageSize: 50, includeUnpublished: true }).items.map((d) => d.title);
    expect(restants).not.toContain("Pelote de laine BRIO");
    expect(restants).toContain("Jeu offert cette semaine");
  });
});
