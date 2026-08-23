// tests/catalogue.test.js — Le suivi du catalogue d'un marchand.
//
// C'est le seul canal dont les anomalies sont mesurées par nous : on relève
// des prix ordinaires, encore et encore, et algorithm.js dit lequel a
// décroché. Deux propriétés le rendent possible, et aucune n'est évidente :
// l'échantillon doit être STABLE d'un passage à l'autre, sans quoi aucun
// historique ne se constitue ; et la rotation doit toujours reprendre par
// les fiches les plus anciennement vues.
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cat = require("../src/catalogue.js");
const { db } = require("../src/db.js");

const urls = (n, p = "https://m.fr/p") => Array.from({ length: n }, (_, i) => `${p}${i}`);

beforeEach(() => db.prepare("DELETE FROM catalogue_fiches").run());

describe("echantillon", () => {
  it("rend la liste entière quand elle tient dans la taille", () => {
    expect(cat.echantillon(urls(5), 800)).toHaveLength(5);
  });

  it("prélève exactement la taille demandée d'un grand catalogue", () => {
    expect(cat.echantillon(urls(78667), 800)).toHaveLength(800);
  });

  it("rend LE MÊME échantillon à chaque appel", () => {
    // Sans cette stabilité, chaque passage relèverait d'autres fiches et
    // aucun prix n'aurait d'historique — donc aucune anomalie mesurable.
    const a = cat.echantillon(urls(10000), 50);
    const b = cat.echantillon(urls(10000), 50);
    expect(a).toEqual(b);
  });

  it("couvre tout le catalogue plutôt que son début", () => {
    const e = cat.echantillon(urls(1000), 10);
    expect(e[0]).toBe("https://m.fr/p0");
    expect(e[9]).toBe("https://m.fr/p900");
  });
});

describe("rotation", () => {
  it("borne ce qu'elle enregistre", () => {
    expect(cat.enregistrerFiches(1, urls(5000), 100)).toBe(100);
    expect(cat.compterFiches(1)).toBe(100);
  });

  it("ne recrée pas une fiche déjà connue", () => {
    cat.enregistrerFiches(1, urls(50), 800);
    expect(cat.enregistrerFiches(1, urls(50), 800)).toBe(0);
  });

  it("commence par les fiches jamais relevées", () => {
    cat.enregistrerFiches(1, urls(10), 800);
    const premiere = cat.prochainesFiches(1, 3);
    expect(premiere).toHaveLength(3);
    for (const f of premiere) cat.marquerRelevee(f.id);

    // Les trois relevées passent en fin de file.
    const suivantes = cat.prochainesFiches(1, 3).map((f) => f.url);
    expect(suivantes.some((u) => premiere.map((p) => p.url).includes(u))).toBe(false);
  });

  it("abandonne une fiche après trois échecs — produit retiré, page déplacée", () => {
    cat.enregistrerFiches(1, urls(1), 800);
    const [f] = cat.prochainesFiches(1, 1);
    cat.marquerEchec(f.id);
    cat.marquerEchec(f.id);
    expect(cat.prochainesFiches(1, 5)).toHaveLength(1);
    cat.marquerEchec(f.id);
    expect(cat.prochainesFiches(1, 5)).toHaveLength(0);
  });

  it("un relevé réussi efface les échecs passés", () => {
    cat.enregistrerFiches(1, urls(1), 800);
    const [f] = cat.prochainesFiches(1, 1);
    cat.marquerEchec(f.id);
    cat.marquerEchec(f.id);
    cat.marquerRelevee(f.id);
    cat.marquerEchec(f.id);
    // Un seul échec au compteur : la fiche reste dans la rotation.
    expect(cat.prochainesFiches(1, 5)).toHaveLength(1);
  });

  it("sépare les catalogues de deux marchands", () => {
    cat.enregistrerFiches(1, urls(5, "https://a.fr/p"), 800);
    cat.enregistrerFiches(2, urls(3, "https://b.fr/p"), 800);
    expect(cat.compterFiches(1)).toBe(5);
    expect(cat.compterFiches(2)).toBe(3);
    expect(cat.prochainesFiches(2, 10).every((f) => f.url.includes("b.fr"))).toBe(true);
  });

  it("rend compte de l'état de la rotation", () => {
    cat.enregistrerFiches(1, urls(4), 800);
    cat.marquerRelevee(cat.prochainesFiches(1, 1)[0].id);
    const e = cat.etatCatalogue(1);
    expect(e.total).toBe(4);
    expect(e.jamais).toBe(3);
    expect(e.abandonnees).toBe(0);
  });
});
