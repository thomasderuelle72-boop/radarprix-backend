// Tests du nouveau moteur d'acquisition : parsers de flux, cibles suivies
// et scan complet (collecte → snapshots → analyse → publication D3).
//
// Aucun appel réseau : fetch est simulé pour le flux comme pour Firecrawl,
// conformément à la règle de tests/setup.js (« aucun test ne part sur le
// réseau »).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

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
      <description>Smartphone Apple, écran 6,1 pouces.</description>
      <enclosure url="https://img.magasin.fr/iphone.jpg" type="image/jpeg" />
    </item>
    <item>
      <title>iPhone 15 128 Go</title>
      <link>https://magasin.fr/iphone-15-128-solde</link>
      <guid>https://magasin.fr/iphone-15-128-solde</guid>
      <price>349,00 €</price>
      <description>Smartphone Apple, écran 6,1 pouces.</description>
      <enclosure url="https://img.magasin.fr/iphone.jpg" type="image/jpeg" />
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

/* Un flux riche, comme en servent les vrais sites : vendeur, prix barré,
   image, état de l'article. C'est exactement ce que l'ancienne lecture
   jetait, laissant des cartes sans vendeur, sans remise et sans visuel. */
const FLUX_RICHE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Bons plans</title>
    <item>
      <title>Casque Sony WH-1000XM5</title>
      <link>https://www.boulanger.com/ref/1234</link>
      <guid>riche-1</guid>
      <description><![CDATA[Super prix ! <del>349,00 €</del> 279,99 € <img src="https://img.example/casque.jpg" />]]></description>
      <media:thumbnail url="https://img.example/vignette.jpg" />
    </item>
    <item>
      <title>iPad Air reconditionné</title>
      <link>https://www.backmarket.fr/ipad-air</link>
      <guid>riche-2</guid>
      <description><![CDATA[399,00 € au lieu de 599 €]]></description>
    </item>
    <item>
      <title>Machine Nespresso -40%</title>
      <link>https://exemple-agregateur.fr/visit/9</link>
      <guid>riche-3</guid>
      <description><![CDATA[89,90 €]]></description>
    </item>
  </channel>
</rss>`;

/* Feed marchand au format Google Shopping : tout y est nommé. */
const FLUX_MARCHAND = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Catalogue</title>
    <item>
      <g:id>SKU-1</g:id>
      <title>Aspirateur Dyson V15</title>
      <link>https://marchand.fr/dyson-v15</link>
      <g:price>649,00 EUR</g:price>
      <g:sale_price>549,00 EUR</g:sale_price>
      <g:brand>Dyson</g:brand>
      <g:condition>refurbished</g:condition>
      <g:image_link>https://img.example/dyson.jpg</g:image_link>
    </item>
  </channel>
</rss>`;

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

describe("ce qu'un flux dit en plus du titre et du prix", () => {
  it("lit le vendeur, le prix barré, l'image et l'état", async () => {
    const offres = await collect.parseFluxRSS(FLUX_RICHE);
    expect(offres).toHaveLength(3);

    // Prix barré en balise <del> : le cas le plus explicite.
    const casque = offres.find((o) => o.name.includes("Casque"));
    expect(casque.price).toBe(279.99);
    expect(casque.refPriceAnnonce).toBe(349);
    expect(casque.img).toBe("https://img.example/vignette.jpg");
    expect(casque.itemCondition).toBe("neuf");

    // « au lieu de » en toutes lettres, et un état qui n'est dit que
    // dans le titre.
    const ipad = offres.find((o) => o.name.includes("iPad"));
    expect(ipad.price).toBe(399);
    expect(ipad.refPriceAnnonce).toBe(599);
    expect(ipad.itemCondition).toBe("reconditionne");

    // Un pourcentage seul dans un titre ne fonde AUCUNE référence. Vu en
    // production : « Clavier C98FRF - 96% Effet Hall » désigne le format du
    // clavier, et le site a affiché « 69,48 € au lieu de 1737 € ».
    const nespresso = offres.find((o) => o.name.includes("Nespresso"));
    expect(nespresso.price).toBe(89.9);
    expect(nespresso.refPriceAnnonce).toBeNull();
  });

  it("nomme le vendeur par le domaine du lien, la marque en repli", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reponse({ texte: FLUX_RICHE }))
    );
    const offres = await collect.collecterCible({
      feedUrl: "https://exemple-agregateur.fr/rss",
      merchant: null,
      searchDomains: [],
      query: "test",
    });

    // Le lien sort du site du flux : c'est ce domaine qui vend.
    expect(offres.find((o) => o.name.includes("Casque")).seller).toBe("Boulanger");
    // Le registre donne le nom tel qu'il s'écrit, pas le domaine rhabillé.
    expect(offres.find((o) => o.name.includes("iPad")).seller).toBe("Back Market");
    // Le lien reste chez l'agrégateur, donc le domaine ne dit rien — mais le
    // titre nomme une marque, et à défaut d'enseigne citée le registre la
    // retient. Repli assumé : une marque qui apparaît seule vend souvent en
    // direct. Jamais l'agrégateur lui-même, qui ne vend rien.
    expect(offres.find((o) => o.name.includes("Nespresso")).seller).toBe("Nespresso");
  });

  it("lit un feed Google Shopping : g:sale_price est le prix payé", () => {
    const [o] = collect.parseFluxXML(FLUX_MARCHAND);
    expect(o.externalId).toBe("SKU-1");
    expect(o.price).toBe(549);
    expect(o.refPriceAnnonce).toBe(649);
    expect(o.seller).toBe("Dyson");
    expect(o.img).toBe("https://img.example/dyson.jpg");
    expect(o.itemCondition).toBe("reconditionne");
  });

  it("ne déduit jamais un prix d'avant d'un pourcentage", () => {
    // Le cas réel qui a produit un « -96 % » sur la page d'accueil.
    expect(collect.prixReference("Clavier C98FRF - 96% Effet Hall", 69.48)).toBeNull();
    expect(collect.prixReference("Écran 27\" -40% ce week-end", 189)).toBeNull();
    // Une référence écrite, elle, est bien lue.
    expect(collect.prixReference("199 € au lieu de 299 €", 199)).toBe(299);
  });

  it("refuse une référence qui n'est pas au-dessus du prix payé", () => {
    // Une source qui annonce « au lieu de 10 € » sur un article à 20 €
    // s'est trompée : afficher une remise négative serait pire que rien.
    expect(collect.prixReference("20 € au lieu de 10 €", 20)).toBeNull();
    expect(collect.prixReference("aucune mention", 20)).toBeNull();
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

  it("ne publie d'un flux que ce qui démontre un avantage (D3)", async () => {
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
    /* Seule l'anomalie est publiée. L'autre article n'a ni remise annoncée
       ni écart mesuré : c'est un produit, pas une affaire. Le publier
       quand même remplissait la page au prix de la crédibilité — 44 % des
       offres en production n'avaient aucune remise démontrable. */
    expect(bilan.publies).toBe(1);
    // « analyses » ne compte que les anomalies : c'est ce que le tableau
    // de bord présente comme détections.
    expect(bilan.analyses).toBe(1);
    expect(bilan.erreurs).toBe(0);

    // Les deux offres sont archivées dans l'historique.
    const snapshots = db
      .prepare("SELECT COUNT(*) AS n FROM snapshots WHERE query = ?")
      .get("iPhone 15 128 Go");
    expect(snapshots.n).toBe(2);

    // Seule l'affaire mesurée entre dans le flux unifié.
    const deals = db
      .prepare("SELECT id, detector, type, price, reference_price, published_at FROM deals WHERE detector = 'D3' ORDER BY price")
      .all();
    expect(deals).toHaveLength(1);
    expect(deals.every((d) => d.published_at !== null)).toBe(true);

    // Et elle est typée pour ce qu'elle est. Aucun article de type
    // « produit » ne subsiste : c'était la catégorie fourre-tout qui
    // remplissait la page d'articles ordinaires présentés comme des deals.
    const anomalie = deals[0];
    expect(anomalie.type).toBe("promo");
    expect(deals.find((d) => d.type === "produit")).toBeUndefined();
    expect(getDeal(anomalie.id).discountPct).toBeGreaterThanOrEqual(40);
    // L'article au prix courant, lui, n'apparaît nulle part : une référence
    // existait pour lui aussi, mais son écart restait sous le seuil.
    expect(bilan.ignorees).toBe(1);

    // Le scan est refermé et la source « flux » consignée.
    const run = listScanRuns(1)[0];
    expect(run.ok_count).toBe(1);
    expect(run.fail_count).toBe(0);
    expect(run.finished_at).not.toBeNull();
    expect(collect.etatCollecte().find((s) => s.source === "flux").etat).toBe("ok");
  });

  it("écarte un article dont on ne sait ni qui le vend ni quoi montrer", async () => {
    // Deux articles d'un agrégateur, sans balise marchand. Le premier
    // nomme son enseigne dans le titre et porte une image ; du second on
    // ne saurait afficher qu'un titre et un nombre.
    const flux = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Flux</title>
  <item>
    <title>Barbecue Weber chez Leroy Merlin</title>
    <link>https://agregateur.fr/visit/1</link><guid>g1</guid>
    <description><![CDATA[<del>299,00 €</del> 199,00 € <img src="https://img.fr/bbq.jpg" />]]></description>
  </item>
  <item>
    <title>Gourde isotherme</title>
    <link>https://agregateur.fr/visit/2</link><guid>g2</guid>
    <description><![CDATA[14,90 €]]></description>
  </item>
</channel></rss>`;
    vi.stubGlobal("fetch", vi.fn(async () => reponse({ texte: flux })));
    collect.addTarget({ query: "Bons plans", feedUrl: "https://agregateur.fr/rss" });

    const bilan = await collect.lancerScan({});
    expect(bilan.offres).toBe(2);
    expect(bilan.publies).toBe(1);
    expect(bilan.ignorees).toBe(1);

    // Et le tri se lit, plutôt que de laisser un site vide inexplicable.
    const flux0 = collect.etatCollecte().find((s) => s.source === "flux");
    expect(flux0.dernierBilan).toContain("1 écartée(s) faute de vendeur ou de visuel");
  });

  it("nomme le vendeur cité dans le titre, même chez un agrégateur", async () => {
    // Le lien ne sort pas de l'agrégateur, donc le domaine ne dit rien —
    // mais le titre nomme l'enseigne, et le registre la reconnaît.
    const flux = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Flux</title>
  <item>
    <title>Barbecue Weber à 199 € chez Leroy Merlin</title>
    <link>https://agregateur.fr/visit/1</link><guid>g1</guid>
    <description><![CDATA[<del>299,00 €</del> 199,00 €]]></description>
  </item>
  <item>
    <title>Casque Sony WH-1000XM5 en promo sur Amazon</title>
    <link>https://agregateur.fr/visit/2</link><guid>g2</guid>
    <description><![CDATA[<del>419,00 €</del> 279,99 €]]></description>
  </item>
</channel></rss>`;
    vi.stubGlobal("fetch", vi.fn(async () => reponse({ texte: flux })));
    collect.addTarget({ query: "Bons plans", feedUrl: "https://agregateur.fr/rss" });

    await collect.lancerScan({});
    const lignes = db
      .prepare("SELECT title, merchant FROM deals WHERE source = ? ORDER BY title")
      .all(`d3-${collect.listTargets()[0].id}`);

    // Sony est une marque, Amazon l'enseigne : c'est Amazon qui vend.
    // Tri par titre : « Barbecue… » précède « Casque… ».
    expect(lignes.map((l) => l.merchant)).toEqual(["Leroy Merlin", "Amazon"]);
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

/* ── Le vrai flux Dealabs ──────────────────────────────────────────
   Cinq articles copiés tels quels du flux public, le 22 août 2026. Les
   fixtures inventées avaient laissé passer trois défauts que ces cinq
   lignes attrapent : la balise pepper:merchant ignorée, la catégorie
   perdue, et un filtre qui écartait cent pour cent des articles parce
   qu'il exigeait un prix barré — qu'aucun d'eux ne porte. */
describe("un flux d'agrégateur réel", () => {
  const FLUX_REEL = readFileSync(new URL("./fixtures/dealabs.xml", import.meta.url), "utf8");

  it("lit le marchand et le prix déclarés par la balise pepper", async () => {
    const offres = await collect.parseFluxRSS(FLUX_REEL);
    expect(offres).toHaveLength(5);
    expect(offres.map((o) => o.seller)).toEqual([
      "Outlet Moto", "Amazon", "Boulanger", "Auchan", "Loaded",
    ]);
    expect(offres.map((o) => o.price)).toEqual([39, 6.99, 179, 12.76, 0.95]);
  });

  it("range chaque article dans sa catégorie, pas dans celle de la cible", async () => {
    const offres = await collect.parseFluxRSS(FLUX_REEL);
    expect(offres[0].category).toBe("auto");      // Auto-Moto
    expect(offres[1].category).toBe("hightech");  // High-Tech
    expect(offres[4].category).toBe("gaming");    // Consoles & Jeux vidéo
  });

  it("rapporte une image pour chaque article", async () => {
    const offres = await collect.parseFluxRSS(FLUX_REEL);
    expect(offres.every((o) => o.img && o.img.startsWith("https://"))).toBe(true);
  });

  it("tire les caractéristiques listées en gras dans la description", async () => {
    const offres = await collect.parseFluxRSS(FLUX_REEL);
    const casque = offres[0];
    expect(casque.caracteristiques.length).toBeGreaterThan(5);
    expect(casque.caracteristiques[0]).toEqual({
      nom: "Matériau",
      valeur: "Coque en résine thermoplastique haute pression (HPTT).",
    });
  });

  it("ne répète pas le prix et le vendeur en tête de description", async () => {
    const offres = await collect.parseFluxRSS(FLUX_REEL);
    // « 39€ - Outlet Moto » ouvre la description d'origine.
    expect(offres[0].description).not.toMatch(/^39/);
    expect(offres[0].description).toMatch(/^Caractéristiques/);
  });

  it("n'en publie aucun, faute du moindre prix de référence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reponse({ texte: FLUX_REEL })));
    collect.addTarget({ query: "Bons plans", feedUrl: "https://www.dealabs.com/rss" });

    const bilan = await collect.lancerScan({});
    expect(bilan.offres).toBe(5);

    /* Le flux RSS de Dealabs ne porte AUCUN prix barré — mesuré sur trente
       articles réels. Sans référence, impossible de démontrer une remise :
       ces cinq articles sont des produits, pas des affaires, et les publier
       revenait à appeler « deal » n'importe quel article d'un flux.

       C'est la limite du flux RSS, pas une régression : la PAGE du même
       site, elle, porte le prix de référence de chaque bon plan. C'est
       pourquoi elle est lue à sa place. */
    expect(bilan.publies).toBe(0);
    expect(bilan.ignorees).toBe(5);

    const lignes = db
      .prepare("SELECT merchant, price, url, image_url, description FROM deals WHERE source = ?")
      .all(`d3-${collect.listTargets().at(-1).id}`);
    expect(lignes).toHaveLength(0);
  });
});

describe("semis des cibles", () => {
  it("crée les sources qui fonctionnent, et rien d'autre", () => {
    const premier = collect.semerCibles();
    // Un agrégateur, plus les catalogues marchands vérifiés.
    expect(premier.creees).toBeGreaterThan(1);

    const cibles = collect.listTargets();
    expect(cibles.map((c) => c.promoUrl)).toContain("https://www.dealabs.com/");
    // Le canal indépendant : nos propres relevés de prix.
    expect(cibles.map((c) => c.catalogueUrl)).toContain("https://www.ldlc.com");
    // Les pages « promotions » des enseignes ne sont plus semées : mesurées
    // une à une, aucune ne rend de produit.
    expect(cibles.filter((c) => c.promoUrl && c.promoUrl.includes("fnac"))).toHaveLength(0);
    // Les catalogues d'affiliation français, relevés sur la liste des flux.
    expect(cibles.map((c) => c.awinFeeds)).toContain("97867");
    expect(cibles.find((c) => c.awinFeeds === "97867").merchant).toBe("Perfumeria Comas");
  });

  it("ne recrée rien au second passage — il tourne à chaque démarrage", () => {
    collect.semerCibles();
    expect(collect.semerCibles().creees).toBe(0);
  });
});

describe("réparation des liens déjà publiés", () => {
  it("réoriente vers le marchand, et retire ce qui reste inatteignable", () => {
    const { upsertDeal, publierDeal } = require("../src/dealsStore.js");
    const base = { detector: "D3", type: "produit", price: 10, category: "tout" };
    const a = upsertDeal({ ...base, source: "vieux", externalId: "a", title: "Casque Sony", merchant: "Boulanger", url: "https://www.dealabs.com/bons-plans/casque-1" });
    const b = upsertDeal({ ...base, source: "vieux", externalId: "b", title: "Casque Moto", merchant: "Outlet Moto", url: "https://www.dealabs.com/bons-plans/casque-2" });
    publierDeal(a);
    publierDeal(b);

    // Et une offre du moteur publiée sans aucun lien : place occupée sur
    // l'accueil, qui ne mène nulle part.
    const c = upsertDeal({ ...base, source: "vieux", externalId: "c", title: "Sans lien", merchant: "Fnac" });
    publierDeal(c);

    const r = collect.reparerLiensAgregateur();
    expect(r.examinees).toBe(3);
    expect(r.repares).toBe(1);
    expect(r.retires).toBe(2);

    const lignes = db.prepare("SELECT id, url, removed_at FROM deals WHERE source = 'vieux' ORDER BY external_id").all();
    // Boulanger est au registre : le lien devient une recherche chez lui.
    expect(lignes[0].url).toContain("boulanger.com");
    expect(lignes[0].removed_at).toBeNull();
    // « Outlet Moto » ne l'est pas : sans domaine, l'offre sort du site.
    expect(lignes[1].removed_at).not.toBeNull();

    // Une seconde exécution ne trouve plus rien à faire.
    expect(collect.reparerLiensAgregateur().examinees).toBe(0);
  });
});

describe("mise en pause des cibles mortes", () => {
  it("arrête les pages promotions d'enseignes, garde les sources qui marchent", () => {
    collect.addTarget({ query: "Promotions Fnac", promoUrl: "https://www.fnac.com/bons-plans" });
    collect.addTarget({ query: "Promotions Boulanger", promoUrl: "https://www.boulanger.com/c/bons-plans" });
    collect.addTarget({ query: "Bons plans Dealabs", promoUrl: "https://www.dealabs.com/" });
    collect.addTarget({ query: "Catalogue marchand", feedUrl: "https://magasin.fr/feed.xml" });

    const r = collect.desactiverCiblesMortes();
    expect(r.arretees).toBe(2);

    const actives = collect.listTargets({ actives: true }).map((c) => c.query);
    // L'agrégateur et le flux marchand continuent : eux rendent des offres.
    expect(actives).toContain("Bons plans Dealabs");
    expect(actives).toContain("Catalogue marchand");
    expect(actives).not.toContain("Promotions Fnac");

    // Idempotent : rien à remettre en pause au second passage.
    expect(collect.desactiverCiblesMortes().arretees).toBe(0);
  });
});

describe("garde-fou contre une extraction cassée", () => {
  it("retire les offres publiées sous un titre répété", () => {
    const { upsertDeal, publierDeal } = require("../src/dealsStore.js");
    const base = { detector: "D3", type: "erreur", category: "tout", url: "https://m.fr/x" };
    // Le cas réel : vingt-cinq fiches publiées sous le nom « Accueil », avec
    // un prix de référence commun et des remises jusqu'à −93 %.
    for (let i = 0; i < 7; i++) {
      publierDeal(upsertDeal({ ...base, source: "cat", externalId: `a${i}`, title: "Accueil", price: 2 + i }));
    }
    publierDeal(upsertDeal({ ...base, source: "cat", externalId: "vrai", title: "Casque Sony WH-1000XM5", price: 279 }));

    const r = collect.retirerOffresMalNommees();
    expect(r.titres).toBe(1);
    expect(r.retirees).toBe(7);

    const restantes = db
      .prepare("SELECT title FROM deals WHERE source = 'cat' AND removed_at IS NULL")
      .all()
      .map((l) => l.title);
    expect(restantes).toEqual(["Casque Sony WH-1000XM5"]);

    // Idempotent : rien à retirer au second passage.
    expect(collect.retirerOffresMalNommees().retirees).toBe(0);
  });
});

/* Le canal d'affiliation : le module awin.js existait, testé, mais n'était
   appelé nulle part ailleurs qu'au diagnostic de démarrage. Aucune offre
   n'en sortait, quelles que soient les clés fournies. */
describe("catalogue d'affiliation (Awin)", () => {
  const enTete = "aw_deep_link|product_name|merchant_product_id|merchant_name|aw_image_url|description|search_price|rrp_price|currency|in_stock|brand_name|ean";
  const ligne = (i, prix, stock = "1") =>
    `https://awin1.com/p/${i}|Casque Sony WH-${i}|SKU${i}|Boulanger|https://img/${i}.jpg|Un casque|${prix}|399.00|EUR|${stock}|Sony|EAN${i}`;

  const catalogue = (n, options = {}) =>
    [enTete, ...Array.from({ length: n }, (_, i) => ligne(i, 100 + i, options.stock ?? "1"))].join("\n");

  function servir(csv, { statut = 200, gzip = false } = {}) {
    const corps = gzip ? require("node:zlib").gzipSync(Buffer.from(csv)) : Buffer.from(csv);
    return vi.fn(async () => ({
      ok: statut < 400,
      status: statut,
      arrayBuffer: async () => corps.buffer.slice(corps.byteOffset, corps.byteOffset + corps.byteLength),
    }));
  }

  beforeEach(() => { process.env.AWIN_FEED_KEY = "cle-de-test"; });
  afterEach(() => { delete process.env.AWIN_FEED_KEY; vi.unstubAllGlobals(); });

  it("refuse de travailler sans la clé des catalogues", async () => {
    delete process.env.AWIN_FEED_KEY;
    await expect(collect.collecterAwin({ awinFeeds: "123" })).rejects.toThrow(/AWIN_FEED_KEY/);
  });

  it("refuse une cible sans identifiant de flux", async () => {
    await expect(collect.collecterAwin({ awinFeeds: "" })).rejects.toThrow(/identifiant de flux/);
  });

  it("lit un catalogue gzippé, qu'Amazon sert sans l'annoncer", async () => {
    vi.stubGlobal("fetch", servir(catalogue(10), { gzip: true }));
    const offres = await collect.collecterAwin({ awinFeeds: "123", merchant: "Boulanger" });
    expect(offres).toHaveLength(10);
    expect(offres[0]).toMatchObject({ seller: "Boulanger", price: 100, refPriceAnnonce: 399, balisage: "awin" });
    // Le lien d'affiliation mène chez le marchand : c'est tout l'intérêt.
    expect(offres[0].url).toMatch(/^https:\/\/awin1\.com\/p\//);
  });

  it("lit aussi un catalogue non compressé", async () => {
    vi.stubGlobal("fetch", servir(catalogue(4)));
    expect(await collect.collecterAwin({ awinFeeds: "1,2" })).toHaveLength(4);
  });

  it("n'en relève qu'un échantillon, quelle que soit la taille du catalogue", async () => {
    // 500 000 références converties en objets feraient passer le processus
    // qui sert le site de quelques mégaoctets à plus d'un gigaoctet.
    vi.stubGlobal("fetch", servir(catalogue(5000)));
    const offres = await collect.collecterAwin({ awinFeeds: "123" });
    expect(offres.length).toBeLessThanOrEqual(61);
    // Le pas parcourt tout le catalogue au lieu d'en lire le début.
    expect(offres.at(-1).name).not.toBe("Casque Sony WH-59");
  });

  it("écarte les références en rupture", async () => {
    const mixte = [
      enTete,
      ligne(1, 100, "1"),
      ligne(2, 200, "0"),
      ligne(3, 300, "1"),
    ].join("\n");
    vi.stubGlobal("fetch", servir(mixte));
    const offres = await collect.collecterAwin({ awinFeeds: "123" });
    expect(offres.map((o) => o.price)).toEqual([100, 300]);
  });

  it("signale un refus du réseau plutôt que de rendre une liste vide", async () => {
    vi.stubGlobal("fetch", servir("", { statut: 403 }));
    await expect(collect.collecterAwin({ awinFeeds: "123" })).rejects.toThrow(/HTTP 403/);
  });
});

describe("eanValide — un code-barres, ou rien", () => {
  const { eanValide } = require("../src/db.js");

  it("accepte les formats de code-barres du commerce", () => {
    expect(eanValide("4548736134560")).toBe("4548736134560"); // EAN-13
    expect(eanValide("12345670")).toBe("12345670"); // EAN-8
    expect(eanValide("012345678905")).toBe("012345678905"); // UPC-A
    expect(eanValide("  3760 - 123456789  ")).toBe("3760123456789"); // espaces et tirets
  });

  it("refuse les références maison des marchands", () => {
    // Le champ `sku` est un fourre-tout. Rapprocher deux marchands sur la
    // coïncidence de leurs références internes serait pire que de ne rien
    // rapprocher : on y croirait.
    expect(eanValide("LDLC-4T2-9B")).toBeNull();
    expect(eanValide("ref-99871")).toBeNull();
    expect(eanValide("Casque Sony WH-1000XM5")).toBeNull();
    expect(eanValide("123456")).toBeNull(); // trop court
    expect(eanValide("123456789012345")).toBeNull(); // trop long
  });

  it("refuse les remplissages", () => {
    expect(eanValide("0000000000000")).toBeNull();
    expect(eanValide("11111111")).toBeNull();
  });

  it("refuse l'absence sans se plaindre", () => {
    expect(eanValide(null)).toBeNull();
    expect(eanValide(undefined)).toBeNull();
    expect(eanValide("")).toBeNull();
  });
});
