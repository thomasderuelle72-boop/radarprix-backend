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

describe("découverte automatique de fiches", () => {
  const d = require("../src/decouverte.js");
  const zlib = require("node:zlib");

  it("distingue une fiche produit d'une page de catégorie", () => {
    for (const url of [
      "https://www.cdiscount.com/informatique/f-1070-abc.html",
      "https://www.fnac.com/a12345678/casque",
      "https://www.boulanger.com/ref/1183624",
      "https://www.decathlon.fr/p/chaussures/_/R-p-309819",
      "https://www.amazon.fr/dp/B08N5WRWNW",
    ]) {
      expect(d.ressembleAFiche(url)).toBe(true);
    }
    for (const url of [
      "https://www.cdiscount.com/informatique/", // section de premier niveau
      "https://www.fnac.com/aide/livraison",
      "https://www.sephora.fr/marques/",
      "https://www.fnac.com/blog/actualites-tech",
      "https://www.darty.com/plan-du-site",
      "https://www.cdiscount.com/media/photo.jpg",
    ]) {
      expect(d.ressembleAFiche(url)).toBe(false);
    }
  });

  it("accepte un candidat douteux plutôt que de manquer un catalogue entier", () => {
    // Choix assumé, après l'échec en production de la reconnaissance par
    // motifs : zéro adresse retenue chez Cdiscount ET la Fnac, sur des
    // sitemaps pourtant lus correctement.
    //
    // Une adresse retenue à tort coûte une lecture, ne rend aucun JSON-LD de
    // produit, se fait compter un échec et finit désactivée. Une adresse
    // rejetée à tort coûte le catalogue entier du marchand. Le juge final
    // n'est pas la forme de l'URL, c'est la page elle-même.
    expect(d.ressembleAFiche("https://www.darty.com/nav/achat/gros_electromenager/")).toBe(true);
  });

  it("lit les sitemaps déclarés dans robots.txt plutôt que de les deviner", async () => {
    const fetcher = async (url) => {
      expect(url).toBe("https://www.exemple.fr/robots.txt");
      return {
        ok: true,
        text: async () => "User-agent: *\nDisallow: /panier\nSitemap: https://www.exemple.fr/sitemap-produits.xml\nSitemap: https://www.exemple.fr/sitemap-2.xml.gz\n",
      };
    };
    const sitemaps = await d.sitemapsDe("www.exemple.fr", { fetcher });
    expect(sitemaps).toEqual([
      "https://www.exemple.fr/sitemap-produits.xml",
      "https://www.exemple.fr/sitemap-2.xml.gz",
    ]);
  });

  it("se rabat sur l'emplacement conventionnel si robots.txt est illisible", async () => {
    const fetcher = async () => ({ ok: false, status: 404, text: async () => "" });
    expect(await d.sitemapsDe("www.exemple.fr", { fetcher })).toEqual(["https://www.exemple.fr/sitemap.xml"]);
  });

  it("sépare un index de sitemaps des pages qu'il référence", () => {
    const index = `<?xml version="1.0"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://x.fr/s1.xml</loc></sitemap>
        <sitemap><loc>https://x.fr/s2.xml</loc></sitemap>
      </sitemapindex>`;
    expect(d.lireSitemap(index).index).toHaveLength(2);
    expect(d.lireSitemap(index).pages).toHaveLength(0);

    const pages = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://x.fr/p/abc</loc></url>
      </urlset>`;
    expect(d.lireSitemap(pages).pages).toEqual(["https://x.fr/p/abc"]);
  });

  it("décompresse un sitemap gzippé, comme le sont la plupart", () => {
    const xml = "<urlset><url><loc>https://x.fr/p/abc</loc></url></urlset>";
    const compresse = zlib.gzipSync(Buffer.from(xml));
    expect(d.texteDe(compresse)).toBe(xml);
    // Et laisse passer un texte déjà clair.
    expect(d.texteDe(xml)).toBe(xml);
  });

  it("descend dans l'index puis ne retient que les fiches", async () => {
    const reponses = {
      "https://www.exemple.fr/robots.txt": "Sitemap: https://www.exemple.fr/index.xml",
      "https://www.exemple.fr/index.xml": `<sitemapindex><sitemap><loc>https://www.exemple.fr/produits.xml</loc></sitemap></sitemapindex>`,
      "https://www.exemple.fr/produits.xml": `<urlset>
        <url><loc>https://www.exemple.fr/p/casque-pro</loc></url>
        <url><loc>https://www.exemple.fr/p/clavier-abc</loc></url>
        <url><loc>https://www.exemple.fr/aide/contact</loc></url>
        <url><loc>https://www.exemple.fr/categories/audio</loc></url>
      </urlset>`,
    };
    const fetcher = async (url) => ({ ok: true, status: 200, text: async () => reponses[url] ?? "" });

    const r = await d.decouvrirFiches("www.exemple.fr", { limite: 50, fetcher });
    expect(r.urls).toEqual([
      "https://www.exemple.fr/p/casque-pro",
      "https://www.exemple.fr/p/clavier-abc",
    ]);
    expect(r.urls.some((u) => u.includes("/aide/"))).toBe(false);
  });

  it("s'arrête à la limite demandée sans parcourir tout le sitemap", async () => {
    const beaucoup = Array.from({ length: 500 }, (_, i) => `<url><loc>https://x.fr/p/produit-${i}</loc></url>`).join("");
    const reponses = {
      "https://x.fr/robots.txt": "Sitemap: https://x.fr/s.xml",
      "https://x.fr/s.xml": `<urlset>${beaucoup}</urlset>`,
    };
    const fetcher = async (url) => ({ ok: true, status: 200, text: async () => reponses[url] ?? "" });
    const r = await d.decouvrirFiches("x.fr", { limite: 25, fetcher });
    expect(r.urls).toHaveLength(25);
  });

  it("signale les sitemaps illisibles sans abandonner les autres", async () => {
    const reponses = {
      "https://x.fr/robots.txt": "Sitemap: https://x.fr/casse.xml\nSitemap: https://x.fr/bon.xml",
      "https://x.fr/bon.xml": `<urlset><url><loc>https://x.fr/p/ok</loc></url></urlset>`,
    };
    const fetcher = async (url) =>
      url === "https://x.fr/casse.xml"
        ? { ok: false, status: 500, text: async () => "" }
        : { ok: true, status: 200, text: async () => reponses[url] ?? "" };

    const r = await d.decouvrirFiches("x.fr", { limite: 10, fetcher });
    expect(r.urls).toEqual(["https://x.fr/p/ok"]);
    expect(r.erreurs.length).toBeGreaterThan(0);
  });
});

describe("désactivation des fiches stériles", () => {
  const { ajouterUrl, verifierFiche, listerUrls } = require("../src/watch.js");

  it("cesse de relire une adresse qui ne rend jamais de prix", async () => {
    const url = "https://x.fr/categorie/sans-produit-test";
    ajouterUrl({ url, merchant: "TestShop", category: "tout" });
    const fiche = listerUrls().find((u) => u.url === url);

    // Une page de catégorie : du HTML valide, mais aucun JSON-LD de produit.
    const fetcher = async () => ({ ok: true, status: 200, text: async () => "<html><body>Rayon</body></html>" });

    let derniere;
    for (let i = 0; i < 4; i++) derniere = await verifierFiche(fiche, { fetcher });

    // C'est ce garde-fou qui rend tenable une découverte permissive : sans
    // lui, une page de catégorie serait relue toutes les quinze minutes
    // indéfiniment, pour rien.
    expect(derniere.ok).toBe(false);
    expect(derniere.desactivee).toBe(true);
    expect(listerUrls().some((u) => u.url === url)).toBe(false);
  });

  it("ne désactive pas sur un échec isolé", async () => {
    const url = "https://x.fr/p/produit-passager-test";
    ajouterUrl({ url, merchant: "TestShop", category: "tout" });
    const fiche = listerUrls().find((u) => u.url === url);
    const r = await verifierFiche(fiche, {
      fetcher: async () => ({ ok: false, status: 503, text: async () => "" }),
    });
    // Un marchand en maintenance ne doit pas coûter la fiche.
    expect(r.ok).toBe(false);
    expect(r.desactivee).toBe(false);
    expect(listerUrls().some((u) => u.url === url)).toBe(true);
  });
});

describe("garde-fous de temps", () => {
  const fp = require("../src/fetchPage.js");
  const d = require("../src/decouverte.js");

  it("pose un délai d'expiration sur chaque requête", async () => {
    let recu = null;
    await fp.recupererPage("https://x.fr/p/1", {
      fetcher: async (_u, opts) => {
        recu = opts;
        return { ok: true, status: 200, text: async () => "<html></html>" };
      },
    });
    // Sans signal, un marchand muet suspend le programme indéfiniment : c'est
    // ce qui a arrêté la découverte en production, processeur au repos.
    expect(recu.signal).toBeDefined();
    expect(typeof recu.signal.aborted).toBe("boolean");
  });

  it("abandonne une requête qui ne répond jamais", async () => {
    const avant = process.env.FETCH_TIMEOUT_MS;
    process.env.FETCH_TIMEOUT_MS = "50";
    try {
      // Un serveur qui accepte la connexion et se tait pour toujours.
      const muet = (_u, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(new Error("délai dépassé")));
        });
      await expect(fp.recupererPage("https://x.fr/p/2", { fetcher: muet })).rejects.toThrow();
    } finally {
      if (avant === undefined) delete process.env.FETCH_TIMEOUT_MS;
      else process.env.FETCH_TIMEOUT_MS = avant;
    }
  });

  it("lit les adresses d'un sitemap sans en construire l'arbre", () => {
    // Le format est trop simple pour justifier le coût d'un arbre DOM sur
    // plusieurs mégaoctets et des dizaines de milliers d'entrées.
    const gros = `<urlset>${Array.from({ length: 20000 }, (_, i) => `<url><loc>https://x.fr/p/${i}</loc></url>`).join("")}</urlset>`;
    const debut = Date.now();
    const lu = d.lireSitemap(gros);
    expect(lu.pages).toHaveLength(20000);
    expect(lu.index).toHaveLength(0);
    expect(Date.now() - debut).toBeLessThan(1000);
  });

  it("distingue un index de sitemaps par le type du document", () => {
    const index = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://x.fr/s1.xml</loc></sitemap></sitemapindex>`;
    expect(d.lireSitemap(index)).toEqual({ index: ["https://x.fr/s1.xml"], pages: [] });
  });

  it("décode les esperluettes échappées des adresses", () => {
    const xml = `<urlset><url><loc>https://x.fr/p?a=1&amp;b=2</loc></url></urlset>`;
    expect(d.lireSitemap(xml).pages).toEqual(["https://x.fr/p?a=1&b=2"]);
  });
});

describe("plafond de données de la découverte", () => {
  const d = require("../src/decouverte.js");

  it("interrompt l'exploration avant d'aspirer un catalogue entier", async () => {
    const avant = process.env.DECOUVERTE_MAX_OCTETS;
    process.env.DECOUVERTE_MAX_OCTETS = "5000";
    try {
      // Un index qui renvoie vers d'autres index, chacun volumineux : sans
      // plafond, on descend indéfiniment. Constaté sur la facture réelle —
      // 94 Mo chez un seul marchand en un après-midi.
      const gros = `<sitemapindex>${Array.from({ length: 20 }, (_, i) => `<sitemap><loc>https://x.fr/s${i}.xml</loc></sitemap>`).join("")}</sitemapindex>` + " ".repeat(6000);
      const fetcher = async (url) =>
        url.endsWith("robots.txt")
          ? { ok: true, status: 200, text: async () => "Sitemap: https://x.fr/index.xml" }
          : { ok: true, status: 200, text: async () => gros };

      const r = await d.decouvrirFiches("x.fr", { limite: 50, fetcher });
      expect(r.erreurs.some((e) => /plafond de .* atteint/.test(e))).toBe(true);
      // Et l'exploration s'arrête tôt plutôt que de parcourir les vingt.
      expect(r.sitemapsLus).toBeLessThan(5);
    } finally {
      if (avant === undefined) delete process.env.DECOUVERTE_MAX_OCTETS;
      else process.env.DECOUVERTE_MAX_OCTETS = avant;
    }
  });
});

describe("rayons pris pour des produits", () => {
  const jl = require("../src/jsonld.js");

  const fiche = (offre) => `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "Product", name: "Casque XYZ", offers: offre,
  })}</script>`;

  it("lit un agrégat de vendeurs pour un même article", () => {
    // Cas légitime : quelques marchands vendent la même référence.
    const o = jl.extraireOffre(fiche({ "@type": "AggregateOffer", lowPrice: "279.00", highPrice: "310.00", offerCount: 4, priceCurrency: "EUR" }));
    expect(o.price).toBe(279);
  });

  it("écarte un agrégat de rayon, dont le prix ne veut rien dire", () => {
    // Cas rencontré en production : « Antenne TV — 10,00 € » chez Boulanger.
    // Un rayon agrège des articles différents ; son « à partir de » publié
    // comme un prix d'article fait afficher des affaires qui n'existent pas.
    expect(jl.extraireOffre(fiche({ "@type": "AggregateOffer", lowPrice: "10.00", highPrice: "890.00", offerCount: 240, priceCurrency: "EUR" }))).toBeNull();
  });

  it("repère un rayon à son écart de prix, même sans offerCount", () => {
    // Les vendeurs d'un même article ne varient pas d'un facteur dix.
    expect(jl.estAgregatDeRayon({ "@type": "AggregateOffer", lowPrice: "9.99", highPrice: "1299.00" })).toBe(true);
    expect(jl.estAgregatDeRayon({ "@type": "AggregateOffer", lowPrice: "279.00", highPrice: "310.00" })).toBe(false);
  });

  it("ne touche pas à une offre simple", () => {
    const o = jl.extraireOffre(fiche({ "@type": "Offer", price: "349.90", priceCurrency: "EUR" }));
    expect(o.price).toBe(349.9);
    expect(jl.estAgregatDeRayon({ "@type": "Offer", price: "349.90" })).toBe(false);
  });
});
