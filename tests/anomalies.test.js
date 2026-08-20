// Phase 3 — signatures d'erreur de prix, JSON-LD, surveillance de fiches.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const an = require("../src/anomalies.js");
const jsonld = require("../src/jsonld.js");
const watch = require("../src/watch.js");

describe("signature : décalage de virgule (constat F4)", () => {
  it("reconnaît le facteur dix", () => {
    expect(an.decalageDecimal(44.9, 449)).toBe(10);
  });

  it("reconnaît le facteur cent", () => {
    expect(an.decalageDecimal(4.49, 449)).toBe(100);
  });

  it("ne voit rien là où il n'y a rien", () => {
    expect(an.decalageDecimal(300, 449)).toBeNull();
    expect(an.decalageDecimal(0, 449)).toBeNull();
  });

  it("la virgule décalée est désormais un signal POSITIF", () => {
    // Le contresens d'origine : −90 % perdait 20 points de confiance, alors
    // que c'est la forme la plus caractéristique d'une erreur de saisie.
    const r = an.evaluer({
      prix: 44.9,
      reference: 449,
      prixDesPairs: [449, 439, 459, 445],
      titre: "Casque Gaming XYZ",
    });
    expect(r.verdict).toBe("erreur");
    expect(r.signatures.map((s) => s.nom)).toContain("decalage_decimal");
    expect(r.vraisemblance).toBeGreaterThan(50);
  });
});

describe("signature : décrochage intra-marchand (constat F6)", () => {
  const maintenant = new Date("2026-08-20T12:00:00Z");

  it("repère un marchand qui décroche par rapport à lui-même", () => {
    const passe = [
      { price: 450, scraped_at: "2026-08-20 10:00:00" },
      { price: 450, scraped_at: "2026-08-20 08:00:00" },
      { price: 449, scraped_at: "2026-08-19 20:00:00" },
    ];
    const d = an.decrochageMarchand(45, passe, { maintenant });
    expect(d).not.toBeNull();
    expect(d.ancienPrix).toBe(450);
    expect(d.chute).toBeCloseTo(0.9, 2); // 45 € contre 450 € : le prix divisé par dix
  });

  it("ignore une baisse ordinaire", () => {
    const passe = [
      { price: 100, scraped_at: "2026-08-20 10:00:00" },
      { price: 100, scraped_at: "2026-08-20 08:00:00" },
      { price: 100, scraped_at: "2026-08-19 08:00:00" },
    ];
    expect(an.decrochageMarchand(85, passe, { maintenant })).toBeNull(); // −15 %
  });

  it("ignore un passé trop ancien", () => {
    const vieux = [{ price: 450, scraped_at: "2026-07-01 10:00:00" }];
    expect(an.decrochageMarchand(45, vieux, { maintenant })).toBeNull();
  });

  it("résiste à une observation aberrante dans le passé du marchand", () => {
    // Une seule valeur folle ne doit pas fabriquer un décrochage.
    const passe = [
      { price: 100, scraped_at: "2026-08-20 10:00:00" },
      { price: 100, scraped_at: "2026-08-20 09:00:00" },
      { price: 9999, scraped_at: "2026-08-20 08:00:00" },
    ];
    expect(an.decrochageMarchand(95, passe, { maintenant })).toBeNull();
  });

  it("suffit à conclure même sans dispersion mesurable", () => {
    // Cas réel : un seul autre marchand connu, donc pas de MAD exploitable.
    const r = an.evaluer({
      prix: 45,
      reference: 450,
      prixDesPairs: [450],
      historiqueMarchand: [
        { price: 450, scraped_at: "2026-08-20 10:00:00" },
        { price: 452, scraped_at: "2026-08-20 08:00:00" },
      ],
      titre: "Aspirateur ABC",
      maintenant,
    });
    expect(r.verdict).toBe("erreur");
  });
});

describe("signaux négatifs", () => {
  it("refuse un prix qui recopie un attribut du titre", () => {
    // 128 est la capacité, pas le prix : c'est une erreur d'extraction de
    // notre côté, pas une affaire.
    expect(an.prixEgaleAttribut(128, "iPhone 15 128 Go")).toBe(true);
    expect(an.prixEgaleAttribut(55, "TV Samsung 55 pouces")).toBe(true);
    expect(an.prixEgaleAttribut(499, "iPhone 15 128 Go")).toBe(false);
  });

  it("écarte la détection quand le prix recopie un attribut", () => {
    const r = an.evaluer({
      prix: 128,
      reference: 899,
      prixDesPairs: [899, 879, 909, 890],
      titre: "iPhone 15 128 Go",
    });
    expect(r.signatures.map((s) => s.nom)).toContain("prix_egale_attribut");
    expect(r.verdict).not.toBe("erreur");
  });

  it("reste méfiant face à un écart énorme sans aucune signature", () => {
    // Typiquement un mauvais rapprochement de produits.
    const r = an.evaluer({
      prix: 50,
      reference: 900,
      prixDesPairs: [900, 500, 1400, 300], // marché très dispersé
      titre: "Produit vague",
    });
    expect(r.signatures.map((s) => s.nom)).toContain("ecart_enorme_sans_signature");
  });
});

describe("seuil adaptatif (constat F5)", () => {
  it("signale un écart modeste sur un marché serré", () => {
    const r = an.evaluer({
      prix: 390,
      reference: 500,
      prixDesPairs: [498, 500, 502, 505, 499],
      titre: "Produit A",
    });
    // −22 % seulement, mais totalement hors distribution.
    expect(r.pct).toBe(22);
    expect(r.verdict).not.toBe("normal");
  });

  it("ne signale rien sur un marché naturellement dispersé", () => {
    const r = an.evaluer({
      prix: 70,
      reference: 175,
      prixDesPairs: [90, 140, 200, 260, 300],
      titre: "Produit B",
    });
    // −60 %, mais c'est du bruit sur ce marché.
    expect(r.verdict).toBe("normal");
  });

  it("repère une offre isolée dans un marché groupé", () => {
    expect(an.estIsole(60, [100, 101, 99, 102, 100])).toBe(true);
    expect(an.estIsole(60, [100, 140, 90, 200, 70])).toBe(false);
  });

  it("reconnaît un prix plancher", () => {
    expect(an.prixPlancher(0.01, 500)).toBe(true);
    expect(an.prixPlancher(1, 500)).toBe(true);
    expect(an.prixPlancher(1, 20)).toBe(false); // produit trop bon marché pour conclure
  });
});

describe("extraction JSON-LD", () => {
  const page = (contenu) => `<html><head>
    <script type="application/ld+json">${JSON.stringify(contenu)}</script>
    </head><body></body></html>`;

  it("lit un produit et son offre", () => {
    const o = jsonld.extraireOffre(
      page({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Casque Sony WH-1000XM5",
        gtin13: "4548736134560",
        offers: { "@type": "Offer", price: "279.99", priceCurrency: "EUR", availability: "https://schema.org/InStock" },
      })
    );
    expect(o.price).toBe(279.99);
    expect(o.currency).toBe("EUR");
    expect(o.inStock).toBe(true);
    expect(o.gtin).toBe("4548736134560");
  });

  it("trouve un produit imbriqué dans un @graph", () => {
    const o = jsonld.extraireOffre(
      page({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebPage", name: "Une page" },
          { "@type": "Product", name: "X", offers: { "@type": "Offer", price: 49.9 } },
        ],
      })
    );
    expect(o.price).toBe(49.9);
  });

  it("lit un AggregateOffer par son prix le plus bas", () => {
    const o = jsonld.extraireOffre(
      page({ "@type": "Product", name: "Y", offers: { "@type": "AggregateOffer", lowPrice: "199", highPrice: "249" } })
    );
    expect(o.price).toBe(199);
  });

  it("détecte une rupture de stock", () => {
    const o = jsonld.extraireOffre(
      page({ "@type": "Product", name: "Z", offers: { price: 10, availability: "https://schema.org/OutOfStock" } })
    );
    expect(o.inStock).toBe(false);
  });

  it("lit les prix quelle que soit la locale", () => {
    expect(jsonld.lirePrix("1 299,00")).toBe(1299);
    expect(jsonld.lirePrix("1,299.00")).toBe(1299);
    expect(jsonld.lirePrix("279.99")).toBe(279.99);
    expect(jsonld.lirePrix("gratuit")).toBeNull();
  });

  it("survit à un bloc JSON-LD malformé et lit les suivants", () => {
    const html = `<html><head>
      <script type="application/ld+json">{ ceci n'est pas du JSON }</script>
      <script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "OK", offers: { price: 12 } })}</script>
      </head></html>`;
    expect(jsonld.extraireOffre(html).price).toBe(12);
  });

  it("se rabat sur les balises meta", () => {
    const html = `<html><head>
      <meta property="product:price:amount" content="59.90">
      <meta property="product:price:currency" content="EUR">
      <meta property="og:title" content="Produit Meta">
      </head></html>`;
    const o = jsonld.extraireOffre(html);
    expect(o.price).toBe(59.9);
    expect(o.source).toBe("meta");
  });

  it("renvoie null sur une page sans prix", () => {
    expect(jsonld.extraireOffre("<html><body>rien</body></html>")).toBeNull();
    expect(jsonld.extraireOffre("")).toBeNull();
  });
});

describe("surveillance de fiches (constat F1)", () => {
  const pageProduit = (prix, stock = "InStock") =>
    `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "Moniteur Surveille 27",
      offers: { price: String(prix), priceCurrency: "EUR", availability: `https://schema.org/${stock}` },
    })}</script></head></html>`;

  const fetcherQuiRend = (html) => async () => ({ ok: true, status: 200, text: async () => html });

  it("enregistre le prix relevé sur une fiche", async () => {
    const fiche = watch.ajouterUrl({
      url: "https://marchand-a.example/produit-1",
      label: "Moniteur Surveille 27",
      merchant: "Darty",
      category: "hightech",
    });
    const r = await watch.verifierFiche(fiche, { fetcher: fetcherQuiRend(pageProduit(299)) });
    expect(r.ok).toBe(true);
    expect(r.prix).toBe(299);
    expect(watch.historiqueFiche(fiche.id)).toHaveLength(1);
  });

  it("détecte un décrochage du marchand par rapport à lui-même", async () => {
    const fiche = watch.ajouterUrl({
      url: "https://marchand-b.example/produit-2",
      label: "Moniteur Surveille 27",
      merchant: "Boulanger",
      category: "hightech",
    });
    // Trois relevés stables, puis l'effondrement.
    for (const p of [450, 450, 449]) {
      await watch.verifierFiche(fiche, { fetcher: fetcherQuiRend(pageProduit(p)) });
    }
    const r = await watch.verifierFiche(fiche, { fetcher: fetcherQuiRend(pageProduit(45)) });
    expect(r.verdict).toBe("erreur");
    expect(r.signatures.map((s) => s.nom)).toContain("decrochage_marchand");
  });

  it("ne publie jamais une offre en rupture", async () => {
    const fiche = watch.ajouterUrl({
      url: "https://marchand-c.example/produit-3",
      label: "Moniteur Surveille 27",
      merchant: "Fnac",
    });
    for (const p of [450, 450, 450]) {
      await watch.verifierFiche(fiche, { fetcher: fetcherQuiRend(pageProduit(p)) });
    }
    const r = await watch.verifierFiche(fiche, { fetcher: fetcherQuiRend(pageProduit(45, "OutOfStock")) });
    expect(r.enStock).toBe(false);
    expect(r.verdict).toBe("normal");
  });

  it("compte les échecs sans faire tomber la surveillance", async () => {
    const fiche = watch.ajouterUrl({ url: "https://marchand-d.example/casse", label: "Test" });
    const r = await watch.verifierFiche(fiche, {
      fetcher: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.erreur).toMatch(/ECONNREFUSED/);
  });

  it("signale une page sans données structurées plutôt que d'inventer un prix", async () => {
    const fiche = watch.ajouterUrl({ url: "https://marchand-e.example/vide", label: "Test" });
    const r = await watch.verifierFiche(fiche, { fetcher: fetcherQuiRend("<html><body>rien</body></html>") });
    expect(r.ok).toBe(false);
    expect(r.erreur).toMatch(/aucun prix/);
  });

  it("compare entre marchands surveillés du même produit", async () => {
    for (const [url, prix] of [
      ["https://p1.example/x", 500],
      ["https://p2.example/x", 505],
      ["https://p3.example/x", 498],
    ]) {
      const f = watch.ajouterUrl({ url, label: "Produit Partage 42", produit: "Produit Partage 42" });
      await watch.verifierFiche(f, { fetcher: fetcherQuiRend(pageProduit(prix)) });
    }
    const cible = watch.ajouterUrl({
      url: "https://p4.example/x",
      label: "Produit Partage 42",
      produit: "Produit Partage 42",
      merchant: "Amazon.fr",
    });
    const pairs = watch.prixDesPairs(cible.product_key, cible.id);
    expect(pairs.sort()).toEqual([498, 500, 505]);
  });

  it("refuse une URL invalide", () => {
    expect(() => watch.ajouterUrl({ url: "pas-une-url" })).toThrow(/invalide/);
  });

  it("extrait le domaine pour espacer les requêtes", () => {
    expect(watch.domaineDe("https://www.darty.com/nav/produit")).toBe("darty.com");
    expect(watch.domaineDe("nawak")).toBeNull();
  });
});

describe("amorçage de la surveillance", () => {
  const { amorcerDepuisSnapshots, estFicheMarchande } = require("../src/watchSeed.js");
  const { insertSnapshots } = require("../src/db.js");
  const { listerUrls } = require("../src/watch.js");

  it("écarte les liens d'agrégateur, qui ne sont pas des fiches marchandes", () => {
    // Relire une page Google Shopping ne dit rien du prix pratiqué par le
    // vendeur, et l'agrégateur refuse d'être interrogé de cette façon.
    expect(estFicheMarchande("https://www.google.com/shopping/product/1")).toBe(false);
    expect(estFicheMarchande("https://www.awin1.com/cread.php?x=1")).toBe(false);
    expect(estFicheMarchande("https://www.fnac.com/a1234/casque")).toBe(true);
  });

  it("promeut les fiches observées plutôt que d'inventer des adresses", () => {
    insertSnapshots("clavier test amorcage", "hightech", [
      { name: "Clavier Test Amorçage", price: 89, seller: "Fnac", url: "https://www.fnac.com/amorcage-1" },
      { name: "Clavier Test Amorçage", price: 92, seller: "Cdiscount", url: "https://www.cdiscount.com/amorcage-2.html" },
    ]);
    const r = amorcerDepuisSnapshots({ limite: 40 });
    expect(r.ajoutees).toBeGreaterThanOrEqual(2);
    const urls = listerUrls().map((u) => u.url);
    expect(urls).toContain("https://www.fnac.com/amorcage-1");
  });

  it("ne surveille pas deux fois la même fiche", () => {
    insertSnapshots("souris test amorcage", "hightech", [
      { name: "Souris Test Amorçage", price: 39, seller: "Darty", url: "https://www.darty.com/amorcage-3" },
      // Même produit, même vendeur, vu deux fois : une seule surveillance.
      { name: "Souris Test Amorçage", price: 41, seller: "Darty", url: "https://www.darty.com/amorcage-3" },
    ]);
    amorcerDepuisSnapshots({ limite: 40 });
    const combien = listerUrls().filter((u) => u.url === "https://www.darty.com/amorcage-3").length;
    expect(combien).toBe(1);
  });

  it("est sans effet au second passage", () => {
    insertSnapshots("ecran test amorcage", "hightech", [
      { name: "Écran Test Amorçage", price: 199, seller: "Boulanger", url: "https://www.boulanger.com/amorcage-4" },
    ]);
    amorcerDepuisSnapshots({ limite: 40 });
    const rejeu = amorcerDepuisSnapshots({ limite: 40 });
    expect(rejeu.ajoutees).toBe(0);
  });

  it("remplace le lien d'agrégateur par le vrai lien marchand une fois résolu", () => {
    const { enregistrerLienMarchand } = require("../src/db.js");
    // Ce que stocke un scan : le lien de l'agrégateur, seul disponible.
    insertSnapshots("tablette test lien", "hightech", [
      { name: "Tablette Test Lien", price: 299, seller: "Fnac", url: "https://www.google.com/shopping/product/42" },
    ]);
    // Sans résolution, l'amorçage l'écarte — ce n'est pas une fiche marchande.
    expect(amorcerDepuisSnapshots({ limite: 40 }).ajoutees).toBe(0);

    // Le lien résolu coûte une requête facturée : il doit être conservé.
    const modifiees = enregistrerLienMarchand("Tablette Test Lien", "Fnac", "https://www.fnac.com/a999/tablette");
    expect(modifiees).toBeGreaterThan(0);

    expect(amorcerDepuisSnapshots({ limite: 40 }).ajoutees).toBe(1);
    expect(listerUrls().map((u) => u.url)).toContain("https://www.fnac.com/a999/tablette");
  });

  it("n'écrase pas un vrai lien marchand déjà connu", () => {
    const { enregistrerLienMarchand } = require("../src/db.js");
    insertSnapshots("montre test lien", "hightech", [
      { name: "Montre Test Lien", price: 199, seller: "Darty", url: "https://www.darty.com/vrai-lien" },
    ]);
    // La condition ne vise que les liens absents ou d'agrégateur : un lien
    // marchand déjà en base est plus fiable que celui qu'on viendrait poser.
    expect(enregistrerLienMarchand("Montre Test Lien", "Darty", "https://www.darty.com/autre")).toBe(0);
  });

  it("écarte les marchands inconnus, sauf demande explicite", () => {
    // On vide d'abord la file des candidats laissés par les tests
    // précédents : sans cela, on mesurerait leur effet et non le nôtre.
    amorcerDepuisSnapshots({ limite: 100 });
    insertSnapshots("the test amorcage", "tout", [
      { name: "Thé Test Amorçage", price: 12, seller: "Luna Gourmet", url: "https://lunagourmet.example/amorcage-5" },
    ]);
    expect(amorcerDepuisSnapshots({ limite: 40 }).ajoutees).toBe(0);
    expect(amorcerDepuisSnapshots({ limite: 40, toutMarchand: true }).ajoutees).toBe(1);
  });
});

describe("récupération d'une page marchande", () => {
  const fp = require("../src/fetchPage.js");
  const env = { ...process.env };

  beforeEach(() => {
    fp.reinitialiserQuota();
  });
  afterEach(() => {
    process.env = { ...env };
    fp.reinitialiserQuota();
  });

  const ok = (html) => async () => ({ ok: true, status: 200, text: async () => html });
  const refus = async () => ({ ok: false, status: 403, text: async () => "" });

  it("passe en direct quand le marchand répond", async () => {
    const r = await fp.recupererPage("https://www.fnac.com/x", { fetcher: ok("<html>prix</html>") });
    expect(r.via).toBe("directe");
    expect(r.html).toContain("prix");
  });

  it("bascule sur Bright Data quand le marchand refuse", async () => {
    process.env.BRIGHT_DATA_API_KEY = "cle";
    let appels = 0;
    const r = await fp.recupererPage("https://www.cdiscount.com/x", {
      fetcher: async (url, opts) => {
        appels++;
        if (appels === 1) return refus();
        // Le repli doit viser l'API Bright Data, pas de nouveau le marchand.
        expect(url).toBe(fp.ENDPOINT_BRIGHTDATA);
        expect(opts.method).toBe("POST");
        expect(JSON.parse(opts.body).url).toBe("https://www.cdiscount.com/x");
        return { ok: true, status: 200, text: async () => "<html>via repli</html>" };
      },
    });
    expect(r.via).toBe("brightdata");
    expect(r.html).toContain("via repli");
  });

  it("ne tente aucun repli sans clé, et remonte l'échec direct", async () => {
    delete process.env.BRIGHT_DATA_API_KEY;
    await expect(fp.recupererPage("https://x.fr/y", { fetcher: refus })).rejects.toThrow(/HTTP 403/);
  });

  it("s'arrête au plafond quotidien plutôt que de laisser filer la facture", async () => {
    process.env.BRIGHT_DATA_API_KEY = "cle";
    process.env.BRIGHT_DATA_MAX_PAR_JOUR = "2";
    const fetcher = async (url) =>
      url === fp.ENDPOINT_BRIGHTDATA
        ? { ok: true, status: 200, text: async () => "<html>ok</html>" }
        : refus();

    await fp.recupererPage("https://a.fr/1", { fetcher });
    await fp.recupererPage("https://a.fr/2", { fetcher });
    // Le troisième dépasse le plafond : l'erreur doit le dire, sinon on
    // croirait le marchand injoignable et on chercherait au mauvais endroit.
    await expect(fp.recupererPage("https://a.fr/3", { fetcher })).rejects.toThrow(/plafond quotidien/);
    expect(fp.etatQuota().utilisees).toBe(2);
  });

  it("remonte les deux causes quand le repli échoue aussi", async () => {
    process.env.BRIGHT_DATA_API_KEY = "cle";
    const fetcher = async (url) =>
      url === fp.ENDPOINT_BRIGHTDATA ? { ok: false, status: 502, text: async () => "" } : refus();
    await expect(fp.recupererPage("https://a.fr/1", { fetcher })).rejects.toThrow(/directe : HTTP 403.*repli : Bright Data a répondu 502/);
  });
});
