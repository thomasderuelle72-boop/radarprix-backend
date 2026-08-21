// Pilotage explicite des détecteurs et remise à zéro des données.
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pilotage = require("../src/pilotage.js");
const { reinitialiser, apercu } = require("../src/reinitialisation.js");
const { upsertDeal, listDeals } = require("../src/dealsStore.js");
const { ajouterUrl, listerUrls } = require("../src/watch.js");

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe("pilotage des détecteurs", () => {
  it("n'active rien quand la liste est absente", () => {
    delete process.env.DETECTEURS_ACTIFS;
    for (const nom of Object.keys(pilotage.PILOTABLES)) {
      expect(pilotage.estActif(nom)).toBe(false);
    }
  });

  it("n'active que ce qui est explicitement nommé", () => {
    process.env.DETECTEURS_ACTIFS = "epic, ebay";
    expect(pilotage.estActif("epic")).toBe(true);
    expect(pilotage.estActif("ebay")).toBe(true);
    // Une clé présente ne suffit plus : c'est tout l'objet du module.
    process.env.AWIN_API_TOKEN = "jeton";
    expect(pilotage.estActif("awin")).toBe(false);
  });

  it("ignore un nom inconnu et le signale", () => {
    process.env.DETECTEURS_ACTIFS = "epic,inexistant";
    expect(pilotage.estActif("inexistant")).toBe(true); // présent dans la liste
    expect(pilotage.etatPilotage().inconnus).toEqual(["inexistant"]);
  });

  it("annonce clairement qu'aucun détecteur ne tourne", () => {
    delete process.env.DETECTEURS_ACTIFS;
    const lignes = [];
    pilotage.annoncerPilotage((l) => lignes.push(l));
    // Un site silencieux doit dire pourquoi, sinon il se lit comme une panne.
    expect(lignes.join(" ")).toMatch(/Aucun détecteur actif/);
    expect(lignes.join(" ")).toMatch(/DETECTEURS_ACTIFS/);
  });
});

describe("remise à zéro", () => {
  it("efface le contenu des détecteurs sans toucher aux comptes", () => {
    upsertDeal({
      source: "test-reinit", externalId: "r1", detector: "D1", type: "code",
      title: "À effacer", merchant: "Fnac", discountPct: 30,
      publishedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
    ajouterUrl({ url: "https://x.fr/p/a-effacer", merchant: "Fnac" });

    const { db } = require("../src/db.js");
    const comptesAvant = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;

    const efface = reinitialiser();
    expect(efface.some((e) => e.table === "deals" && e.lignes > 0)).toBe(true);

    expect(listDeals({ pageSize: 50 }).total).toBe(0);
    expect(listerUrls()).toHaveLength(0);
    // Les comptes sont les seules données que personne ne peut régénérer.
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get().n).toBe(comptesAvant);
  });

  it("sait conserver l'historique, qui met des jours à se reconstituer", () => {
    ajouterUrl({ url: "https://x.fr/p/garde-historique", merchant: "Fnac" });
    const efface = reinitialiser({ garderHistorique: true });
    const gardees = efface.filter((e) => e.conservee).map((e) => e.table);
    expect(gardees).toContain("snapshots");
    expect(gardees).toContain("watched_prices");
  });

  it("dit ce qu'elle effacerait sans rien effacer", () => {
    upsertDeal({
      source: "test-apercu", externalId: "a1", detector: "D2", type: "gratuit",
      title: "Toujours là", price: 0,
    });
    const avant = apercu().find((a) => a.table === "deals").lignes;
    apercu();
    expect(apercu().find((a) => a.table === "deals").lignes).toBe(avant);
    expect(avant).toBeGreaterThan(0);
  });
});
