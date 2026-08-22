// Tests du nouveau moteur d'acquisition : parsers de flux, cibles suivies
// et scan complet (collecte → snapshots → analyse → publication D3).
//
// Aucun appel réseau : fetch est simulé pour le flux comme pour Firecrawl,
// conformément à la règle de tests/setup.js (« aucun test ne part sur le
// réseau »).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const collect = require("../src/collect.js");
const { db, listScanRuns } = require("../src/db.js");
const { getDeal } = require("../src/dealsStore.js");

const FLUX_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Bonnes affaires</title>
    <item>
      <title>iPhone 15 128 Go</title>
      <link>https://magasin.fr/iphone-15-128</link>
      <guid>https://magasin.fr/iphone-15-128</guid>
      <price>999,00 €</price>
    </item>
    <item>
      <title>iPhone 15 128 Go</title>
      <link>https://magasin.fr/iphone-15-128-solde</link>
      <guid>https://magasin.fr/iphone-15-128-solde</guid>
      <price>349,00 €</price>
    </item>
  </channel>
</rss>`;

const FLUX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Catalogue</title>
    <item>
      <title>iPhone 15 128 Go</title>
      <link>https://magasin.fr/iphone-15-128</link>
      <g:price>899.00 EUR</g:price>
    </item>
    <item>
      <title>iPhone 15 128 Go</title>
      <link>https://magasin.fr/iphone-15-128-b</link>
      <g:price>399.00 EUR</g:price>
    </item>
  </channel>
</rss>`;

/** Réponse HTTP factice — le code ne lit que ok / text() / json(). */
function reponse({ ok = true, texte = null, json = null } = {}) {
  return { ok, text: async () => texte, json: async () => json };
}

beforeEach(() => {
  // Chaque test repart avec un jeu de cibles vierge : lancerScan balaie
  // toutes les cibles actives, celles du test précédent fausseraient le bilan.
  db.prepare("DELETE FROM watch_targets").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FIRECRAWL_API_KEY;
});

describe("extrairePrix", () => {
  it("lit les formats de prix français", () => {
    expect(collect.extrairePrix("699,00 €")).toBe(699);
    expect(collect.extrairePrix("Prix : 12,99 euros")).toBe(12.99);
    expect(collect.extrairePrix("EUR 499.99")).toBe(499.99);
    expect(collect.extrairePrix("19,90\u00A0€")).toBe(19.9);
  });

  it("refuse un nombre sans monnaie — un titre n'est pas un prix", () => {
    expect(collect.extrairePrix("iPhone 15 128 Go")).toBeNull();
    expect(collect.extrairePrix(null)).toBeNull();
    expect(collect.extrairePrix("")).toBeNull();
  });

  // Ces deux familles de cas renvoyaient un prix trop bas, et un prix trop
  // bas se transforme en fausse « erreur de prix » publiée aux membres :
  // c'est le pire défaut possible pour ce moteur, et il frappait surtout les
  // articles chers, ceux où une vraie erreur compte le plus.
  it("garde les milliers d'un montant séparé", () => {
    expect(collect.extrairePrix("1 299,00 €")).toBe(1299);        // espace
    expect(collect.extrairePrix("1\u202F299,00 €")).toBe(1299);    // espace fine insécable
    expect(collect.extrairePrix("1.299,00 €")).toBe(1299);        // point de milliers
    expect(collect.extrairePrix("2 499,99 €")).toBe(2499.99);
    expect(collect.extrairePrix("12 000 €")).toBe(12000);
  });

  it("ignore les montants qui ne sont pas le prix de l'article", () => {
    expect(collect.extrairePrix("Économisez 50 € — MacBook à 1 899 €")).toBe(1899);
    expect(collect.extrairePrix("Livraison 4,99 € — Casque 199 €")).toBe(199);
    expect(collect.extrairePrix("30 € de réduction, soit 169,99 €")).toBe(169.99);
    expect(collect.extrairePrix("Frais de port 3,90 €")).toBeNull();
  });

  it("ne confond pas une unité avec la monnaie", () => {
    // « 15 eurêka » n'est pas « 15 euros » : sans garde après le mot, la
    // lecture partait sur n'importe quel nombre suivi d'un mot en « eur ».
    expect(collect.extrairePrix("Lot 15 eurêka")).toBeNull();
  });
});

describe("parsers de flux", () => {
  it("parse un flux RSS 2.0, avec le prix en balise dédiée ou dans le titre", async () => {
    const offres = await collect.parseFluxRSS(FLUX_RSS);
    expect(offres).toHaveLength(2);
    expect(offres[0]).toMatchObject({ name: "iPhone 15 128 Go", price: 999, seller: null });
    expect(offres[1].price).toBe(349);

    // Certains flux ne publient pas de balise prix : le prix vit dans le titre.
    const dansLeTitre = await collect.parseFluxRSS(
      `<rss version="2.0"><channel><item><title>Soldes iPhone 15 128 Go 449,00 €</title><link>https://x.fr/1</link></item></channel></rss>`
    );
    expect(dansLeTitre[0].price).toBe(449);
  });

  it("parse un feed marchand XML type Google Shopping (g:price)", async () => {
    const offres = collect.parseFluxXML(FLUX_XML);
    expect(offres).toHaveLength(2);
    expect(offres.map((o) => o.price)).toEqual([899, 399]);
    expect(offres[0].url).toBe("https://magasin.fr/iphone-15-128");
  });
});

describe("cibles suivies (watch_targets)", () => {
  it("exige un flux ou un domaine — une cible sans source est refusée", () => {
    expect(collect.addTarget({ query: "iPhone 15 128 Go" }).ok).toBe(false);
    expect(collect.addTarget({ query: "iPhone 15 128 Go", feedUrl: "https://magasin.fr/feed.xml" }).ok).toBe(true);
  });

  it("accepte un flux ou des domaines, et les restitue", () => {
    const r = collect.addTarget({
      query: "PS5 Slim",
      category: "gaming",
      merchant: "Magasin",
      domains: ["magasin.fr", "autre.fr"],
    });
    expect(r.ok).toBe(true);
    const cible = collect.getTarget(r.target.id);
    expect(cible.searchDomains).toEqual(["magasin.fr", "autre.fr"]);
    expect(cible.merchant).toBe("Magasin");
    expect(cible.category).toBe("gaming");
  });

  it("désactive sans supprimer, et supprime", () => {
    const { target } = collect.addTarget({ query: "Switch 2", feedUrl: "https://x.fr/feed.xml" });
    expect(collect.updateTarget(target.id, { active: false }).target.active).toBe(false);
    expect(collect.listTargets({ actives: true }).some((t) => t.id === target.id)).toBe(false);
    expect(collect.deleteTarget(target.id)).toBe(true);
    expect(collect.getTarget(target.id)).toBeNull();
  });
});

describe("scan complet", () => {
  it("sans aucune cible, le scan ne fait rien et ne plante pas", async () => {
    const bilan = await collect.lancerScan({});
    expect(bilan.cibles).toBe(0);
  });

  it("collecte, analyse et publie l'anomalie d'un flux (D3)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reponse({ texte: FLUX_RSS }))
    );
    collect.addTarget({
      query: "iPhone 15 128 Go",
      category: "high-tech",
      merchant: "Magasin",
      feedUrl: "https://magasin.fr/feed.xml",
    });

    const bilan = await collect.lancerScan({});
    expect(bilan.cibles).toBe(1);
    expect(bilan.offres).toBe(2);
    expect(bilan.publies).toBe(1);
    expect(bilan.erreurs).toBe(0);

    // Les deux offres sont archivées dans l'historique.
    const snapshots = db
      .prepare("SELECT COUNT(*) AS n FROM snapshots WHERE query = ?")
      .get("iPhone 15 128 Go");
    expect(snapshots.n).toBe(2);

    // L'anomalie est publiée dans le flux unifié, détecteur D3.
    const deal = db
      .prepare("SELECT id, detector, type, price, reference_price, published_at FROM deals WHERE detector = 'D3'")
      .get();
    expect(deal).not.toBeUndefined();
    expect(deal.type).toBe("promo");
    expect(deal.published_at).not.toBeNull();
    expect(getDeal(deal.id).discountPct).toBeGreaterThanOrEqual(40);

    // Le scan est refermé et la source « flux » consignée.
    const run = listScanRuns(1)[0];
    expect(run.ok_count).toBe(1);
    expect(run.fail_count).toBe(0);
    expect(run.finished_at).not.toBeNull();
    expect(collect.etatCollecte().find((s) => s.source === "flux").etat).toBe("ok");
  });

  it("passe par Firecrawl (recherche + scrape) quand la cible n'a pas de flux", async () => {
    process.env.FIRECRAWL_API_KEY = "cle-de-test";
    const fetchMock = vi.fn(async (url, options) => {
      if (url.includes("/search")) {
        return reponse({
          json: {
            success: true,
            data: [
              { url: "https://magasin.fr/p/1", title: "iPhone 15 128 Go" },
              { url: "https://magasin.fr/p/2", title: "iPhone 15 128 Go" },
            ],
          },
        });
      }
      // /scrape — la page cible est dans le corps de la requête, pas dans l'URL.
      const page = JSON.parse(options.body).url;
      const prix = page.includes("/p/2") ? 400 : 1000;
      return reponse({
        json: {
          success: true,
          data: {
            markdown: `# iPhone 15 128 Go\n\nPrix : ${prix},00 €`,
            metadata: { title: "iPhone 15 128 Go" },
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    collect.addTarget({
      query: "iPhone 15 128 Go",
      merchant: "Magasin",
      domains: ["magasin.fr"],
    });

    const bilan = await collect.lancerScan({});
    expect(bilan.offres).toBe(2);
    expect(bilan.publies).toBe(1);
    expect(bilan.erreurs).toBe(0);
    expect(fetchMock).toHaveBeenCalled();
    expect(collect.etatCollecte().find((s) => s.source === "firecrawl").etat).toBe("ok");
  });

  it("sans clé Firecrawl, la cible est comptée en échec sans appel réseau", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    collect.addTarget({ query: "Switch 2", domains: ["magasin.fr"] });
    const bilan = await collect.lancerScan({});

    expect(bilan.erreurs).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(collect.etatCollecte().find((s) => s.source === "firecrawl").etat).toBe("instable");
  });
});
