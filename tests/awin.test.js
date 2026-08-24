// tests/awin.test.js — Lecture des catalogues produits Awin.
//
// Ce module est la voie vers l'indépendance : un marchand qui refuse un
// robot anonyme publie volontiers son catalogue à ses partenaires. Le
// format est un CSV que personne ne contrôle chez nous, d'où ces tests :
// une colonne déplacée ou une description contenant le séparateur suffit
// à publier des prix faux.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const awin = require("../src/awin.js");

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AWIN_API_TOKEN;
  delete process.env.AWIN_PUBLISHER_ID;
  delete process.env.AWIN_FEED_KEY;
});

const ENTETE = "aw_deep_link|product_name|merchant_product_id|merchant_name|aw_image_url|description|search_price|rrp_price|currency|in_stock|brand_name|ean|category_name";

describe("offresDuCatalogue", () => {
  it("lit une ligne complète", () => {
    const csv = `${ENTETE}
https://www.awin1.com/pclick.php?p=123|Casque Sony WH-1000XM5|SKU1|Boulanger|https://img.fr/a.jpg|Casque à réduction de bruit|279.99|419.00|EUR|1|Sony|4548736134560|Audio`;
    const [o] = awin.offresDuCatalogue(csv);
    expect(o.name).toBe("Casque Sony WH-1000XM5");
    expect(o.price).toBe(279.99);
    expect(o.refPriceAnnonce).toBe(419);
    expect(o.seller).toBe("Boulanger");
    expect(o.img).toBe("https://img.fr/a.jpg");
    expect(o.ean).toBe("4548736134560");
    expect(o.disponible).toBe(true);
    // Le lien d'affiliation mène chez le marchand : c'est tout l'intérêt.
    expect(o.url).toContain("awin1.com");
  });

  it("retient le domaine du marchand, pas celui du réseau d'affiliation", () => {
    // Le lien de sortie passe par awin1.com ; s'en servir pour le logo
    // afficherait la marque du réseau sur une carte RadarPrix.
    const csv = `product_name|search_price|merchant_name|merchant_deep_link
Parfum|39.90|Perfumeria Comas|https://www.perfumeriascomas.fr/p/123`;
    expect(awin.offresDuCatalogue(csv)[0].marchandDomaine).toBe("perfumeriascomas.fr");
  });

  it("ne prétend pas connaître le domaine quand le catalogue ne le donne pas", () => {
    const csv = `product_name|search_price|merchant_name
Parfum|39.90|Perfumeria Comas`;
    expect(awin.offresDuCatalogue(csv)[0].marchandDomaine).toBeNull();
  });

  it("survit à une description qui contient le séparateur et des guillemets", () => {
    // Le cas qui décale toutes les colonnes suivantes quand on découpe
    // naïvement : le prix se retrouverait dans la marque.
    const csv = `${ENTETE}
lien|Écran 27"|SKU2|LDLC|img|"Dalle IPS | 144 Hz | dit ""rapide"""|189.00|229.00|EUR|1|LG|123|Informatique`;
    const [o] = awin.offresDuCatalogue(csv);
    expect(o.price).toBe(189);
    expect(o.marque).toBe("LG");
    expect(o.description).toBe('Dalle IPS | 144 Hz | dit "rapide"');
  });

  it("retrouve les colonnes par leur nom, pas par leur position", () => {
    // Awin en ajoute et en réordonne : un index figé finirait par lire la
    // description dans la colonne du prix.
    const csv = `product_name|search_price|merchant_name|rrp_price
Clavier|49.90|Fnac|79.90`;
    const [o] = awin.offresDuCatalogue(csv);
    expect(o.price).toBe(49.9);
    expect(o.seller).toBe("Fnac");
    expect(o.refPriceAnnonce).toBe(79.9);
  });

  it("ignore un prix conseillé qui n'est pas au-dessus du prix payé", () => {
    // Les catalogues le recopient souvent à l'identique : afficher « -0 % »
    // vaut moins que ne rien afficher.
    const csv = `product_name|search_price|rrp_price
Souris|29.90|29.90`;
    expect(awin.offresDuCatalogue(csv)[0].refPriceAnnonce).toBeNull();
  });

  it("écarte une ligne sans nom ou sans prix", () => {
    const csv = `product_name|search_price
|19.90
Produit sans prix|
Bon produit|9.90`;
    const offres = awin.offresDuCatalogue(csv);
    expect(offres.map((o) => o.name)).toEqual(["Bon produit"]);
  });

  it("ne rend rien d'un fichier vide ou sans colonnes utiles", () => {
    expect(awin.offresDuCatalogue("")).toEqual([]);
    expect(awin.offresDuCatalogue("a|b\n1|2")).toEqual([]);
  });
});

describe("urlCatalogue", () => {
  it("assemble l'adresse avec les colonnes demandées", () => {
    process.env.AWIN_FEED_KEY = "CLE";
    const u = awin.urlCatalogue([111, 222]);
    // `download` télécharge le catalogue ; `list` énumère les catalogues et
    // rend le même en-tête quels que soient les identifiants passés. La
    // confusion a fait échouer les dix premières cibles semées.
    expect(u).toContain("/datafeed/download/");
    expect(u).not.toContain("/datafeed/list/");
    expect(u).toContain("/apikey/CLE/");
    expect(u).toContain("/fid/111,222/");
    expect(u).toContain("search_price");
    expect(u).toContain("compression/gzip");
  });
});

describe("diagnostic", () => {
  it("dit ce qui manque plutôt que d'échouer en silence", async () => {
    expect(await awin.diagnostic()).toEqual({
      actif: false,
      raison: "AWIN_PUBLISHER_ID et AWIN_API_TOKEN vide(s) ou absente(s)",
    });

    // Une variable déclarée mais vide ne doit pas passer pour renseignée :
    // c'est exactement l'état trouvé en production.
    process.env.AWIN_PUBLISHER_ID = "42";
    process.env.AWIN_API_TOKEN = "   ";
    const d = await awin.diagnostic();
    expect(d.actif).toBe(false);
    expect(d.raison).toBe("AWIN_API_TOKEN vide(s) ou absente(s)");
  });

  it("nomme le refus quand le jeton est invalide", async () => {
    process.env.AWIN_API_TOKEN = "faux";
    process.env.AWIN_PUBLISHER_ID = "1";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));
    const d = await awin.diagnostic();
    expect(d.actif).toBe(false);
    expect(d.raison).toContain("401");
  });

  it("compte les programmes rejoints quand tout répond", async () => {
    process.env.AWIN_API_TOKEN = "bon";
    process.env.AWIN_PUBLISHER_ID = "42";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [
        { id: 1, name: "Boulanger", displayUrl: "https://www.boulanger.com/" },
        { id: 2, name: "Fnac", displayUrl: "https://www.fnac.com" },
      ],
    })));
    const d = await awin.diagnostic();
    expect(d.actif).toBe(true);
    expect(d.programmes).toBe(2);
    expect(d.exemples).toEqual(["Boulanger", "Fnac"]);
  });
});

/* Codes promo et promotions du réseau — le service qui manquait au site.
   Le contrat de l'API a été relevé dans des intégrations publiques, la
   documentation d'Awin étant inaccessible : on vérifie donc ici les trois
   points où les intégrations se cassent le plus souvent. */
describe("promotions et codes promo", () => {
  const promo = (over = {}) => ({
    promotionId: 4242,
    advertiser: { id: 7, name: "Boulanger" },
    title: "10 % sur le petit électroménager",
    description: "Hors produits déjà remisés.",
    voucher: { code: "ELECTRO10" },
    type: "voucher",
    startDate: "2026-08-01T00:00:00",
    endDate: "2026-09-30T23:59:59",
    urlTracking: "https://www.awin1.com/cread.php?awinmid=7&p=boulanger.com",
    ...over,
  });

  beforeEach(() => {
    process.env.AWIN_PUBLISHER_ID = "1234";
    process.env.AWIN_API_TOKEN = "jeton-de-test";
  });
  afterEach(() => {
    delete process.env.AWIN_PUBLISHER_ID;
    delete process.env.AWIN_API_TOKEN;
    vi.unstubAllGlobals();
  });

  it("appelle « publisher » au singulier, en POST, sans Bearer", async () => {
    let vue = null;
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      vue = { url: String(url), options };
      return { ok: true, status: 200, json: async () => ({ data: [promo()] }) };
    }));

    await awin.promotions();

    // Le chemin au pluriel en GET n'existe plus : c'est le piège nº1.
    expect(vue.url).toMatch(/\/publisher\/1234\/promotions/);
    expect(vue.url).not.toMatch(/\/publishers\//);
    expect(vue.options.method).toBe("POST");
    // Le jeton se passe brut, pas en Bearer : piège nº2.
    expect(vue.options.headers.Authorization).toBe("jeton-de-test");
    expect(vue.options.headers.Authorization).not.toMatch(/Bearer/);
    // Et aussi en paramètre, qu'Awin accepte également.
    expect(vue.url).toMatch(/accessToken=jeton-de-test/);
  });

  it("filtre sur la France et les programmes rejoints", async () => {
    let corps = null;
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      corps = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }));

    await awin.promotions({ membership: "joined", type: "voucher" });
    /* `status` est obligatoire : sans lui Awin répond 400 ou 500 sans jamais
       nommer le champ manquant — c'est ce qui a fait échouer la première
       intégration en production. */
    expect(corps.filters).toEqual({
      membership: "joined",
      status: "active",
      type: "voucher",
      regionCodes: ["FR"],
    });
    // Pagination par numéro de page, pas par curseur : ce service n'en rend pas.
    expect(corps.pagination).toEqual({ page: 1, pageSize: 200 });
  });

  it("distingue un code à copier d'une promotion automatique", () => {
    expect(awin.enOffrePromo(promo()).typePromo).toBe("code");
    expect(awin.enOffrePromo(promo()).voucherCode).toBe("ELECTRO10");

    const sansCode = awin.enOffrePromo(promo({ voucher: null }));
    expect(sansCode.typePromo).toBe("promo");
    expect(sansCode.voucherCode).toBeNull();
  });

  it("porte un lien qui mène vraiment chez le marchand", () => {
    // Sur les 126 offres publiées le 23 août 2026, une seule ouvrait autre
    // chose qu'une page de recherche. C'est ce que ce canal répare.
    const o = awin.enOffrePromo(promo());
    expect(o.url).toMatch(/^https:\/\/www\.awin1\.com\/cread\.php/);
    expect(o.lienType).toBe("produit");
    expect(o.expiresAt).toBe("2026-09-30T23:59:59");
  });

  it("écarte une promotion qu'on ne pourrait pas présenter", () => {
    expect(awin.enOffrePromo(promo({ urlTracking: null }))).toBeNull();
    expect(awin.enOffrePromo(promo({ advertiser: null }))).toBeNull();
    expect(awin.enOffrePromo(promo({ title: "", description: "" }))).toBeNull();
  });

  it("rend une liste vide plutôt que d'échouer sans identifiants", async () => {
    delete process.env.AWIN_API_TOKEN;
    expect(await awin.promotions()).toEqual([]);
  });
});

/* Awin répond 400 « JSON parse error » sur une valeur de membership mal
   casée — un message qui accuse le corps entier plutôt que le champ fautif,
   et fait chercher au mauvais endroit. Les trois valeurs valides sont
   « joined », « notJoined » et « all ». */
describe("valeurs acceptées par le filtre membership", () => {
  it("transmet la casse exacte, sans la normaliser", async () => {
    process.env.AWIN_PUBLISHER_ID = "1234";
    process.env.AWIN_API_TOKEN = "jeton";
    let corps = null;
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      corps = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }));

    await awin.promotions({ membership: "notJoined" });
    expect(corps.filters.membership).toBe("notJoined");

    await awin.promotions({ membership: "all" });
    expect(corps.filters.membership).toBe("all");

    delete process.env.AWIN_PUBLISHER_ID;
    delete process.env.AWIN_API_TOKEN;
    vi.unstubAllGlobals();
  });
});

describe("droit d'employer le lien de tracking", () => {
  it("remonte l'annonceur, pour savoir si on y a droit", () => {
    const o = awin.enOffrePromo({
      promotionId: 1,
      advertiser: { id: 77, name: "Boulanger" },
      title: "10 %",
      urlTracking: "https://www.awin1.com/cread.php?awinmid=77",
    });
    /* Les conditions d'Awin réservent les liens de tracking aux programmes
       rejoints. Sans l'identifiant de l'annonceur, impossible de savoir
       lesquels on a le droit d'employer. */
    expect(o.advertiserId).toBe("77");
  });
});

/* Le flux brut n'est pas publiable tel quel. Chaque cas ci-dessous vient
   des 32 premières promotions reçues en production le 23 août 2026. */
describe("nettoyage des promotions du réseau", () => {
  const base = {
    promotionId: 1,
    advertiser: { id: 9, name: "Samsung FR" },
    urlTracking: "https://www.awin1.com/cread.php?awinmid=9",
  };

  it("retrouve le code quand le titre EST le code", () => {
    // Vu tel quel : titre « JEDEMENAGE », voucher.code vide.
    const o = awin.enOffrePromo({
      ...base,
      title: "JEDEMENAGE",
      description: "10% de remise immédiate sur une sélection de produits",
      voucher: null,
    });
    expect(o.voucherCode).toBe("JEDEMENAGE");
    expect(o.typePromo).toBe("code");
    // Un code ne décrit rien : c'est la description qui porte l'offre.
    expect(o.name).toBe("10% de remise immédiate sur une sélection de produits");
  });

  it("retrouve le code noyé dans le texte", () => {
    const o = awin.enOffrePromo({
      ...base,
      title: "15 % de réduction pour la rentrée scolaire",
      description: "Copiez le code et collez-le dans votre panier : RENTREE15",
      voucher: null,
    });
    expect(o.voucherCode).toBe("RENTREE15");
    expect(o.name).toBe("15 % de réduction pour la rentrée scolaire");
  });

  it("préfère le code déclaré quand il existe", () => {
    const o = awin.enOffrePromo({ ...base, title: "Offre", voucher: { code: "OFFICIEL10" } });
    expect(o.voucherCode).toBe("OFFICIEL10");
  });

  it("écarte les marchés étrangers, que l'API laisse passer", () => {
    /* regionCodes: ["FR"] est ignoré en silence : Samsung BG, Samsung RO et
       La Redoute UK sont arrivés malgré la demande. Un site français qui
       affiche une promotion roumaine ne se rattrape pas en expliquant que
       l'API a mal filtré. */
    /* La première version énumérait les pays à écarter, et l'Estonie y
       manquait : « Samsung EE » est passé en production avec son titre en
       estonien. Énumérer les pays du monde pour n'en garder qu'un est un
       travail sans fin — la règle est inversée, seul FR passe. */
    for (const nom of ["Samsung BG", "Samsung RO", "La Redoute UK", "Zalando DE",
                       "Samsung EE", "Nike LT", "Boohoo AU"]) {
      expect(awin.enOffrePromo({ ...base, advertiser: { id: 9, name: nom }, title: "Offre" })).toBeNull();
    }
    expect(awin.enOffrePromo({ ...base, title: "Offre" })).not.toBeNull();
    // Un nom sans suffixe de pays est français : Nocibé, Cdiscount, Fnac…
    for (const nom of ["Nocibé", "Cdiscount", "La Redoute"]) {
      expect(awin.enOffrePromo({ ...base, advertiser: { id: 9, name: nom }, title: "Offre" })).not.toBeNull();
    }
  });

  it("rend un nom d'enseigne, pas un nom de programme", () => {
    const o = awin.enOffrePromo({
      ...base,
      advertiser: { id: 3, name: "Momox shop FR (revente/outbound)" },
      title: "12 % de réduction",
    });
    expect(o.seller).toBe("Momox shop");
  });

  it("distingue une promotion automatique d'un code à copier", () => {
    const auto = awin.enOffrePromo({ ...base, title: "Livraison offerte dès 49 €", voucher: null });
    expect(auto.typePromo).toBe("promo");
    expect(auto.voucherCode).toBeNull();
  });
});

/* Le rapprochement des noms de programme. Une première version comparait les
   chaînes collées : « Ikea » y retrouvait « Tezeus Bikeaffiliate » et
   « Likeair », « Nature & Découvertes » y retrouvait « ur » et « N/A ».
   Vu en production sur les 21 311 programmes du réseau. */
describe("retrouver une enseigne parmi les programmes du réseau", () => {
  const reseau = [
    { id: 20473, name: "Nature & Decouvertes FR" },
    { id: 31173, name: "Electro Depot BE" },
    { id: 43089, name: "ur" },
    { id: 88839, name: "N/A" },
    { id: 121004, name: "Like Air" },
    { id: 124150, name: "Tezeus Bike Affiliate" },
  ];

  it("retrouve une enseigne malgré l'accent et le suffixe de marché", () => {
    const r = awin.chercherProgrammes(reseau, ["Nature & Découvertes"])[0];
    expect(r.trouves.map((t) => t.id)).toEqual([20473]);
  });

  it("ne confond plus un nom court avec une sous-chaîne", () => {
    // « ikea » se cache dans « bikeaffiliate » et dans « likeair ».
    expect(awin.chercherProgrammes(reseau, ["Ikea"])[0].trouves).toEqual([]);
  });

  it("ne retient pas les noms de deux lettres, qui matchaient tout", () => {
    const r = awin.chercherProgrammes(reseau, ["Nature & Découvertes"])[0];
    expect(r.trouves.map((t) => t.nom)).not.toContain("ur");
    expect(r.trouves.map((t) => t.nom)).not.toContain("N/A");
  });

  it("distingue les marchés d'une même enseigne", () => {
    const r = awin.chercherProgrammes(reseau, ["Electro Dépôt"])[0];
    expect(r.trouves.map((t) => t.nom)).toEqual(["Electro Depot BE"]);
  });

  it("rend une liste vide plutôt que tout, pour une enseigne absente", () => {
    expect(awin.chercherProgrammes(reseau, ["LDLC"])[0].trouves).toEqual([]);
  });
});
