// tests/marchands.test.js — Le registre des enseignes et le lien de sortie.
//
// Deux choses s'y jouent, et les deux se voient tout de suite sur le site :
// à qui l'on attribue une vente, et où l'on envoie l'acheteur.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  MARCHANDS, marchandDepuisDomaine, marchandDepuisTexte,
  reconnaitreMarchand, lienMarchand, requeteDeTitre, pagePromo,
  domainePourLogo,
} = require("../src/marchands.js");

describe("le registre", () => {
  it("ne contient ni domaine ni nom en double", () => {
    const noms = MARCHANDS.map((m) => m.nom);
    const domaines = MARCHANDS.map((m) => m.domaine);
    expect(new Set(noms).size).toBe(noms.length);
    expect(new Set(domaines).size).toBe(domaines.length);
  });

  it("décrit chaque entrée complètement", () => {
    for (const m of MARCHANDS) {
      expect(m.nom.length).toBeGreaterThan(1);
      expect(m.domaine).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
      expect(Array.isArray(m.alias)).toBe(true);
    }
  });

  it("construit une page promotions valide quand elle existe", () => {
    for (const m of MARCHANDS.filter((x) => x.promo)) {
      expect(pagePromo(m)).toMatch(/^https:\/\/www\./);
    }
    expect(pagePromo({ domaine: "x.fr", promo: null })).toBeNull();
  });
});

describe("reconnaître un marchand", () => {
  it("lit un domaine, sous-domaines compris", () => {
    expect(marchandDepuisDomaine("www.amazon.fr").nom).toBe("Amazon");
    expect(marchandDepuisDomaine("boutique.orange.fr").nom).toBe("Orange");
    expect(marchandDepuisDomaine("inconnu-total.fr")).toBeNull();
  });

  it("lit un nom cité dans un texte", () => {
    expect(marchandDepuisTexte("Casque à 199 € chez Boulanger").nom).toBe("Boulanger");
    expect(marchandDepuisTexte("Bon plan Cdiscount").nom).toBe("Cdiscount");
  });

  it("ignore un nom d'enseigne qui n'est qu'un mot courant", () => {
    // « Courir » est un verbe, « Orange » un fruit : sans marqueur de
    // vendeur devant, ce ne sont pas des enseignes.
    expect(marchandDepuisTexte("Il faut courir pour en profiter")).toBeNull();
    expect(marchandDepuisTexte("Jus d orange pas cher")).toBeNull();
    expect(marchandDepuisTexte("Offre valable chez Courir").nom).toBe("Courir");
  });

  it("préfère l enseigne à la marque", () => {
    // « Aspirateur Dyson chez Boulanger » se vend chez Boulanger.
    expect(marchandDepuisTexte("Aspirateur Dyson chez Boulanger").nom).toBe("Boulanger");
    // Seule, la marque sert de repli : elle vend souvent en direct.
    expect(marchandDepuisTexte("Aspirateur Dyson V15 en promo").nom).toBe("Dyson");
  });

  it("fait primer le domaine sur le texte", () => {
    const r = reconnaitreMarchand({ url: "https://www.fnac.com/a1", texte: "chez Boulanger" });
    expect(r.nom).toBe("Fnac");
  });
});

describe("le lien de sortie", () => {
  it("construit la recherche du marchand quand on la connaît", () => {
    const u = lienMarchand({ domaine: "www.amazon.fr", titre: "Casque Sony WH-1000XM5" });
    expect(u).toContain("amazon.fr");
    expect(u).toContain(encodeURIComponent("Casque Sony WH-1000XM5"));
  });

  it("retombe sur le site du marchand quand on ne sait pas y chercher", () => {
    expect(lienMarchand({ domaine: "www.outletmoto.com", titre: "Casque" }))
      .toBe("https://www.outletmoto.com/");
  });

  it("ne rend aucun lien plutôt qu un lien faux", () => {
    expect(lienMarchand({ titre: "Produit sans marchand" })).toBeNull();
  });
});

describe("requeteDeTitre", () => {
  it("retire le bruit qui ne trouve rien chez un marchand", () => {
    expect(requeteDeTitre("[Via App] Écouteurs Apple AirPods Pro 3"))
      .toBe("Écouteurs Apple AirPods Pro 3");
    expect(requeteDeTitre("Dordogne sur PC (Dématérialisé - Steam)"))
      .toBe("Dordogne sur PC");
  });

  it("coupe à la première énumération", () => {
    expect(requeteDeTitre("Pack de 3 routeurs Tenda Nova MW12 - Tri-Bande AC2100, 600m²"))
      .toBe("Pack de 3 routeurs Tenda Nova MW12");
  });

  it("garde le titre d origine plutôt que de rendre une recherche vide", () => {
    expect(requeteDeTitre("[Promo]")).toBe("[Promo]");
  });
});

/* Dix-huit cartes sur quarante-neuf s'affichaient en initiales, dont six
   Amazon : collectées avant que le champ domaine n'existe. */
describe("domainePourLogo", () => {
  it("préfère ce que la collecte a rangé dans l'offre", () => {
    expect(domainePourLogo({ domaine: "www.boulanger.com", url: "https://x.fr/a", marchand: "Amazon" })).toBe("boulanger.com");
  });

  it("retombe sur l'hôte du lien, plus précis que le nom", () => {
    // Une offre Amazon.es doit porter son propre logo, pas celui d'amazon.fr.
    expect(domainePourLogo({ url: "https://www.amazon.es/dp/1", marchand: "Amazon.es" })).toBe("amazon.es");
    // Et un marchand absent du registre en obtient un quand même.
    expect(domainePourLogo({ url: "https://www.bike24.fr/p/2", marchand: "BIKE24" })).toBe("bike24.fr");
  });

  it("retombe sur le registre quand il n'y a pas de lien", () => {
    expect(domainePourLogo({ marchand: "Decathlon" })).toBe("decathlon.fr");
  });

  it("n'affiche jamais le logo d'un agrégateur", () => {
    expect(domainePourLogo({ url: "https://www.dealabs.com/bons-plans/1", marchand: "Inconnu" })).toBeNull();
  });

  it("rend null plutôt que d'inventer", () => {
    expect(domainePourLogo({})).toBeNull();
    expect(domainePourLogo({ url: "pas une url", marchand: "Inconnu" })).toBeNull();
  });
});
