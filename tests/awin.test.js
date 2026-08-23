// tests/awin.test.js — Lecture des catalogues produits Awin.
//
// Ce module est la voie vers l'indépendance : un marchand qui refuse un
// robot anonyme publie volontiers son catalogue à ses partenaires. Le
// format est un CSV que personne ne contrôle chez nous, d'où ces tests :
// une colonne déplacée ou une description contenant le séparateur suffit
// à publier des prix faux.
import { describe, it, expect, vi, afterEach } from "vitest";
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
