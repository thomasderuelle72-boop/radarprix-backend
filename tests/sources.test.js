// Détecteurs D1 (promotions, codes promo) et D2 (gratuit).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const epic = require("../src/sources/epic.js");
const promos = require("../src/sources/promos.js");

/** Extrait de réponse Epic, à la forme du catalogue réel. */
function reponseEpic(elements) {
  return { data: { Catalog: { searchStore: { elements } } } };
}

function jeuEpic(over = {}) {
  return {
    id: "jeu-1",
    title: "Un Jeu Offert",
    description: "Description du jeu.",
    namespace: "ns1",
    keyImages: [
      { type: "Thumbnail", url: "https://img/thumb.jpg" },
      { type: "OfferImageWide", url: "https://img/wide.jpg" },
    ],
    price: { totalPrice: { discountPrice: 0, originalPrice: 1999, currencyCode: "EUR" } },
    catalogNs: { mappings: [{ pageSlug: "un-jeu-offert" }] },
    promotions: {
      promotionalOffers: [
        {
          promotionalOffers: [
            { startDate: "2026-08-19T15:00:00.000Z", endDate: "2026-08-26T15:00:00.000Z" },
          ],
        },
      ],
      upcomingPromotionalOffers: [],
    },
    ...over,
  };
}

const MAINTENANT = new Date("2026-08-20T12:00:00.000Z");

describe("D2 — Epic Games", () => {
  it("retient un jeu réellement offert", () => {
    const [d] = epic.parseEpicFreeGames(reponseEpic([jeuEpic()]), MAINTENANT);
    expect(d.type).toBe("gratuit");
    expect(d.detector).toBe("D2");
    expect(d.price).toBe(0);
    expect(d.referencePrice).toBe(19.99); // centimes convertis en euros
    expect(d.url).toBe("https://store.epicgames.com/fr/p/un-jeu-offert");
    expect(d.imageUrl).toBe("https://img/wide.jpg"); // grande image préférée
    expect(d.category).toBe("gaming");
  });

  it("écarte une promotion payante — le catalogue en contient", () => {
    const remise = jeuEpic({
      id: "jeu-remise",
      price: { totalPrice: { discountPrice: 999, originalPrice: 1999, currencyCode: "EUR" } },
    });
    expect(epic.parseEpicFreeGames(reponseEpic([remise]), MAINTENANT)).toHaveLength(0);
  });

  it("écarte un free-to-play : gratuit mais sans fenêtre promotionnelle", () => {
    const f2p = jeuEpic({
      id: "f2p",
      price: { totalPrice: { discountPrice: 0, originalPrice: 0, currencyCode: "EUR" } },
      promotions: null,
    });
    expect(epic.parseEpicFreeGames(reponseEpic([f2p]), MAINTENANT)).toHaveLength(0);
  });

  it("écarte une offre déjà terminée", () => {
    const fini = jeuEpic({
      id: "fini",
      promotions: {
        promotionalOffers: [
          {
            promotionalOffers: [
              { startDate: "2026-08-01T15:00:00.000Z", endDate: "2026-08-08T15:00:00.000Z" },
            ],
          },
        ],
      },
    });
    expect(epic.parseEpicFreeGames(reponseEpic([fini]), MAINTENANT)).toHaveLength(0);
  });

  it("retient une offre à venir, mais datée dans le futur", () => {
    const futur = jeuEpic({
      id: "futur",
      promotions: {
        promotionalOffers: [],
        upcomingPromotionalOffers: [
          {
            promotionalOffers: [
              { startDate: "2026-08-26T15:00:00.000Z", endDate: "2026-09-02T15:00:00.000Z" },
            ],
          },
        ],
      },
    });
    const [d] = epic.parseEpicFreeGames(reponseEpic([futur]), MAINTENANT);
    expect(new Date(d.startsAt) > MAINTENANT).toBe(true);
  });

  it("préfère la fenêtre en cours quand les deux existent", () => {
    const deux = jeuEpic({
      id: "deux",
      promotions: {
        promotionalOffers: [
          {
            promotionalOffers: [
              { startDate: "2026-08-19T15:00:00.000Z", endDate: "2026-08-26T15:00:00.000Z" },
            ],
          },
        ],
        upcomingPromotionalOffers: [
          {
            promotionalOffers: [
              { startDate: "2026-08-26T15:00:00.000Z", endDate: "2026-09-02T15:00:00.000Z" },
            ],
          },
        ],
      },
    });
    const [d] = epic.parseEpicFreeGames(reponseEpic([deux]), MAINTENANT);
    expect(d.startsAt).toBe("2026-08-19T15:00:00.000Z");
  });

  it("survit à une réponse vide ou malformée", () => {
    expect(epic.parseEpicFreeGames(null)).toEqual([]);
    expect(epic.parseEpicFreeGames({})).toEqual([]);
    expect(epic.parseEpicFreeGames(reponseEpic([null, {}, { id: "x" }]))).toEqual([]);
  });

  it("trouve le slug quel que soit son emplacement", () => {
    expect(epic.choisirSlug({ catalogNs: { mappings: [{ pageSlug: "a" }] } })).toBe("a");
    expect(epic.choisirSlug({ offerMappings: [{ pageSlug: "b" }] })).toBe("b");
    expect(epic.choisirSlug({ productSlug: "c" })).toBe("c");
    expect(epic.choisirSlug({})).toBeNull();
  });

  it("remonte l'erreur si Epic répond mal", async () => {
    const fetcher = async () => ({ ok: false, status: 503 });
    await expect(epic.fetchEpicFreeGames({ fetcher })).rejects.toThrow(/503/);
  });
});

describe("D1 — promotions et codes promo", () => {
  it("distingue un code promo d'une promotion automatique", () => {
    const code = promos.normaliserDealStrackr({
      id: "s1",
      title: "-20% sur tout le site",
      code: "BIENVENUE20",
      advertiser: "Cdiscount",
    });
    expect(code.type).toBe("code");
    expect(code.voucherCode).toBe("BIENVENUE20");

    const promo = promos.normaliserDealStrackr({
      id: "s2",
      title: "Vente flash électroménager",
      advertiser: "Darty",
    });
    expect(promo.type).toBe("promo");
    expect(promo.voucherCode).toBeNull();
  });

  it("n'invente jamais de référence de prix depuis un flux marchand", () => {
    const d = promos.normaliserDealStrackr({
      id: "s3",
      title: "-70% sur les casques",
      advertiser: "Fnac",
      // Le flux annonce un prix barré : il ne doit pas devenir une référence.
      old_price: "299",
      price: "89",
    });
    expect(d.referencePrice).toBeNull();
    expect(d.discountPct).toBe(70); // la remise déclarée reste une information
  });

  it("rattache aux catégories du site", () => {
    expect(promos.categoriser("Gaming")).toBe("gaming");
    expect(promos.categoriser(null, "Casque audio high-tech")).toBe("hightech");
    expect(promos.categoriser("Chaussures de running")).toBe("sport");
    expect(promos.categoriser("Quelque chose d'indéfini")).toBe("tout");
  });

  it("ne retient pas un pourcentage aberrant", () => {
    expect(promos.remiseDeclaree("-150% sur tout")).toBeNull();
    expect(promos.remiseDeclaree("0% de remise")).toBeNull();
    expect(promos.remiseDeclaree("Jusqu'à 50% de réduction")).toBe(50);
  });

  it("normalise une offre Awin", () => {
    const d = promos.normaliserOffreAwin({
      promotionId: "a1",
      title: "Livraison offerte dès 25€",
      advertiser: { name: "Boulanger" },
      urlTracking: "https://awin/track/1",
      startDate: "2026-08-01T00:00:00Z",
      endDate: "2026-09-01T00:00:00Z",
    });
    expect(d.source).toBe("awin");
    expect(d.merchant).toBe("Boulanger");
    expect(d.url).toBe("https://awin/track/1");
  });

  it("ignore une entrée sans identifiant ou sans titre", () => {
    expect(promos.normaliserDealStrackr({ title: "sans id" })).toBeNull();
    expect(promos.normaliserOffreAwin({ promotionId: "x" })).toBeNull();
  });

  it("déballe les enveloppes REST courantes", () => {
    expect(promos.extraireListe([1, 2])).toEqual([1, 2]);
    expect(promos.extraireListe({ deals: [1] })).toEqual([1]);
    expect(promos.extraireListe({ data: [2] })).toEqual([2]);
    expect(promos.extraireListe({ inconnu: [3] })).toEqual([]);
  });

  it("lit les nombres quel que soit le format", () => {
    expect(promos.nombre("12,50 €")).toBe(12.5);
    expect(promos.nombre("1299.99")).toBe(1299.99);
    expect(promos.nombre(42)).toBe(42);
    expect(promos.nombre("gratuit")).toBeNull();
  });

  it("échoue explicitement sans clé plutôt que de partir sur le réseau", async () => {
    await expect(promos.fetchStrackrDeals()).rejects.toThrow(/STRACKR_API_KEY/);
    await expect(promos.fetchAwinOffers()).rejects.toThrow(/AWIN_API_TOKEN/);
  });
});

const { fetchAwinOffers } = promos;

describe("D1 — Awin : diagnostic des pannes", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  function reponse(status) {
    return async () => ({ ok: false, status, json: async () => ({}) });
  }

  it("distingue une adresse inexistante d'un jeton refusé", async () => {
    process.env.AWIN_API_TOKEN = "jeton";
    process.env.AWIN_PUBLISHER_ID = "3048875";
    // C'est la confusion qui a coûté du temps en production : un 404 sur une
    // URL inventée se lisait « Awin a répondu 404 » et faisait chercher la clé.
    await expect(fetchAwinOffers({ fetcher: reponse(404) })).rejects.toThrow(/l'adresse n'existe pas/);
    await expect(fetchAwinOffers({ fetcher: reponse(401) })).rejects.toThrow(/refusé le jeton/);
    await expect(fetchAwinOffers({ fetcher: reponse(429) })).rejects.toThrow(/limite le débit/);
  });

  it("interpole l'identifiant d'éditeur dans l'adresse configurée", async () => {
    process.env.AWIN_API_TOKEN = "jeton";
    process.env.AWIN_PUBLISHER_ID = "3048875";
    process.env.AWIN_OFFERS_URL = "https://api.awin.com/publisher/{publisherId}/promotions";
    let vue = null;
    await fetchAwinOffers({
      fetcher: async (url) => {
        vue = url;
        return { ok: true, json: async () => [] };
      },
    });
    expect(vue).toBe("https://api.awin.com/publisher/3048875/promotions");
  });

  it("envoie un POST avec son corps quand l'API l'exige", async () => {
    process.env.AWIN_API_TOKEN = "jeton";
    process.env.AWIN_PUBLISHER_ID = "3048875";
    process.env.AWIN_OFFERS_METHOD = "post";
    process.env.AWIN_OFFERS_BODY = '{"type":"voucher"}';
    let recu = null;
    await fetchAwinOffers({
      fetcher: async (_url, opts) => {
        recu = opts;
        return { ok: true, json: async () => [] };
      },
    });
    expect(recu.method).toBe("POST");
    expect(recu.body).toBe('{"type":"voucher"}');
    expect(recu.headers["Content-Type"]).toBe("application/json");
  });

  it("n'envoie aucun corps quand la méthode est forcée en GET", async () => {
    process.env.AWIN_API_TOKEN = "jeton";
    process.env.AWIN_PUBLISHER_ID = "3048875";
    process.env.AWIN_OFFERS_METHOD = "GET";
    process.env.AWIN_OFFERS_BODY = '{"ignoré":true}';
    let recu = null;
    await fetchAwinOffers({
      fetcher: async (_url, opts) => {
        recu = opts;
        return { ok: true, json: async () => [] };
      },
    });
    expect(recu.method).toBe("GET");
    expect(recu.body).toBeUndefined();
  });

  it("vise par défaut le point d'entrée réel de la documentation Awin", async () => {
    // Les trois parties ont été fausses en production : GET au lieu de POST,
    // « publishers » au pluriel, « offers » au lieu de « promotions ».
    process.env.AWIN_API_TOKEN = "jeton";
    process.env.AWIN_PUBLISHER_ID = "3048875";
    let vue = null;
    let recu = null;
    await fetchAwinOffers({
      fetcher: async (url, opts) => {
        vue = url;
        recu = opts;
        return { ok: true, json: async () => ({ promotions: [] }) };
      },
    });
    expect(vue).toBe("https://api.awin.com/publisher/3048875/promotions");
    expect(recu.method).toBe("POST");
    expect(JSON.parse(recu.body)).toEqual({ filters: { membership: "joined" } });
  });

  it("lit les promotions dans l'enveloppe renvoyée par Awin", async () => {
    process.env.AWIN_API_TOKEN = "jeton";
    process.env.AWIN_PUBLISHER_ID = "3048875";
    const offres = await fetchAwinOffers({
      fetcher: async () => ({
        ok: true,
        json: async () => ({
          promotions: [
            {
              promotionId: 991,
              title: "-20 % sur tout le site",
              type: "voucher",
              voucherCode: "RADAR20",
              advertiser: { name: "Cdiscount" },
              urlTracking: "https://www.awin1.com/cread.php?...",
              startDate: "2026-08-01",
              endDate: "2026-09-01",
            },
          ],
        }),
      }),
    });
    expect(offres).toHaveLength(1);
    expect(offres[0]).toMatchObject({
      source: "awin",
      externalId: 991,
      detector: "D1",
      type: "code",
      voucherCode: "RADAR20",
      merchant: "Cdiscount",
      discountPct: 20,
    });
  });
});

describe("eBay — second prix du marché français", () => {
  const ebay = require("../src/sources/ebay.js");
  const env = { ...process.env };

  beforeEach(() => ebay.oublierJeton());
  afterEach(() => {
    process.env = { ...env };
    ebay.oublierJeton();
  });

  const jetonOk = { ok: true, status: 200, json: async () => ({ access_token: "T", expires_in: 7200 }) };

  it("interroge le marché français, pas l'américain", async () => {
    process.env.EBAY_APP_ID = "id";
    process.env.EBAY_CERT_ID = "secret";
    let entetes = null;
    await ebay.chercher({
      q: "casque",
      fetcher: async (url, opts) => {
        if (url === ebay.OAUTH) return jetonOk;
        entetes = opts.headers;
        return { ok: true, status: 200, json: async () => ({ itemSummaries: [] }) };
      },
    });
    // Sans cet en-tête, eBay répond en dollars avec des vendeurs américains.
    expect(entetes["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_FR");
  });

  it("cherche par code-barres quand il est connu, sinon par mots-clés", async () => {
    process.env.EBAY_APP_ID = "id";
    process.env.EBAY_CERT_ID = "secret";
    const vues = [];
    const fetcher = async (url) => {
      if (url === ebay.OAUTH) return jetonOk;
      vues.push(url);
      return { ok: true, status: 200, json: async () => ({ itemSummaries: [] }) };
    };
    await ebay.chercher({ gtin: "0711719541028", fetcher });
    await ebay.chercher({ q: "manette ps5", fetcher });
    expect(vues[0]).toContain("gtin=0711719541028");
    expect(vues[0]).not.toContain("q=");
    expect(vues[1]).toContain("q=manette");
  });

  it("ne redemande pas un jeton encore valide", async () => {
    process.env.EBAY_APP_ID = "id";
    process.env.EBAY_CERT_ID = "secret";
    let jetons = 0;
    const fetcher = async (url) => {
      if (url === ebay.OAUTH) {
        jetons++;
        return jetonOk;
      }
      return { ok: true, status: 200, json: async () => ({ itemSummaries: [] }) };
    };
    await ebay.chercher({ q: "a", fetcher });
    await ebay.chercher({ q: "b", fetcher });
    expect(jetons).toBe(1);
  });

  it("sépare le neuf du reconditionné, qui ne se comparent pas", () => {
    const base = { itemId: "1", title: "Console", price: { value: "399.00", currency: "EUR" } };
    expect(ebay.normaliserArticle({ ...base, condition: "New" })).toMatchObject({ itemCondition: "neuf", type: "produit", detector: "D3" });
    expect(ebay.normaliserArticle({ ...base, condition: "Refurbished" })).toMatchObject({ itemCondition: "reconditionne", type: "occasion", detector: "D4" });
    expect(ebay.normaliserArticle({ ...base, condition: "Used" })).toMatchObject({ itemCondition: "occasion", detector: "D4" });
  });

  it("n'invente jamais de prix de référence", () => {
    const article = ebay.normaliserArticle({
      itemId: "9", title: "Casque", price: { value: "79.90", currency: "EUR" }, condition: "New",
    });
    // eBay donne un prix, pas une valeur de marché : afficher une remise
    // contre une référence inventée serait un mensonge au visiteur.
    expect(article.referencePrice).toBeNull();
    expect(article.price).toBe(79.9);
  });

  it("écarte un article sans prix exploitable", () => {
    expect(ebay.normaliserArticle({ itemId: "1", title: "X" })).toBeNull();
    expect(ebay.normaliserArticle({ itemId: "1", title: "X", price: { value: "0" } })).toBeNull();
  });
});

describe("extracteurs Bright Data — collecte asynchrone", () => {
  const sc = require("../src/sources/scraper.js");
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("ne devine aucun identifiant d'extracteur", () => {
    // La leçon d'Awin : un identifiant plausible mais faux coûte plus cher
    // qu'une source désactivée, parce qu'on cherche la panne du mauvais côté.
    delete process.env.BRIGHT_DATA_DATASETS;
    expect(sc.extracteurs()).toEqual([]);
    process.env.BRIGHT_DATA_DATASETS = "cdiscount:gd_abc123:hightech, fnac:gd_def456";
    expect(sc.extracteurs()).toEqual([
      { marchand: "cdiscount", datasetId: "gd_abc123", categorie: "hightech" },
      { marchand: "fnac", datasetId: "gd_def456", categorie: "tout" },
    ]);
  });

  it("mémorise la collecte déclenchée pour la reprendre plus tard", async () => {
    process.env.BRIGHT_DATA_API_KEY = "cle";
    const id = await sc.declencher({
      datasetId: "gd_test",
      marchand: "TestShop",
      urls: ["https://x.fr/p/1", "https://x.fr/p/2"],
      fetcher: async (url, opts) => {
        expect(url).toContain("/datasets/v3/trigger?dataset_id=gd_test");
        // Le corps attendu est une liste d'objets {url}, pas des chaînes.
        expect(JSON.parse(opts.body)).toEqual([{ url: "https://x.fr/p/1" }, { url: "https://x.fr/p/2" }]);
        return { ok: true, status: 200, json: async () => ({ snapshot_id: "snap_1" }) };
      },
    });
    expect(id).toBe("snap_1");
    expect(sc.collectesEnCours().some((c) => c.snapshot_id === "snap_1")).toBe(true);
  });

  it("traite un 202 comme « pas encore prête », pas comme une panne", async () => {
    process.env.BRIGHT_DATA_API_KEY = "cle";
    const r = await sc.recupererCollecte("snap_1", {
      fetcher: async () => ({ ok: false, status: 202, json: async () => ({}) }),
    });
    // Sans ce cas, on abandonnerait des instantanés parfaitement valides.
    expect(r.prete).toBe(false);
    expect(r.produits).toEqual([]);
  });

  it("accepte les vocabulaires différents d'un extracteur à l'autre", () => {
    const a = sc.normaliserProduit(
      { url: "https://x.fr/p/1", title: "Casque", final_price: "79,90", currency: "EUR", upc: "123456789" },
      { marchand: "Fnac", categorie: "hightech" }
    );
    const b = sc.normaliserProduit(
      { product_url: "https://y.fr/p/2", product_name: "Clavier", price: 45.5, ean: "987" },
      { marchand: "LDLC" }
    );
    expect(a).toMatchObject({ title: "Casque", price: 79.9, gtin: "123456789", merchant: "Fnac", type: "produit" });
    expect(b).toMatchObject({ title: "Clavier", price: 45.5, gtin: "987", merchant: "LDLC" });
    // Jamais de référence inventée, quel que soit l'extracteur.
    expect(a.referencePrice).toBeNull();
  });

  it("repère une rupture de stock quelle qu'en soit l'écriture", () => {
    const rupture = sc.normaliserProduit({ url: "https://x.fr/p/3", title: "X", price: 10, availability: "Out of stock" });
    const dispo = sc.normaliserProduit({ url: "https://x.fr/p/4", title: "Y", price: 10, availability: "In stock" });
    expect(rupture.enRupture).toBe(true);
    expect(dispo.enRupture).toBe(false);
  });

  it("écarte un produit sans prix ou sans adresse", () => {
    expect(sc.normaliserProduit({ url: "https://x.fr/p/5", title: "X" })).toBeNull();
    expect(sc.normaliserProduit({ title: "X", price: 10 })).toBeNull();
    expect(sc.normaliserProduit({ url: "https://x.fr/p/6", title: "X", price: 0 })).toBeNull();
  });
});
