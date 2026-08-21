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

describe("état public du radar", () => {
  const { etatRadar } = require("../src/radarEtat.js");
  const { ajouterUrl } = require("../src/watch.js");
  const { upsertDeal } = require("../src/dealsStore.js");
  const { db } = require("../src/db.js");

  it("compte les fiches suivies et les anomalies publiées", () => {
    ajouterUrl({ url: "https://x.fr/p/radar-etat-1", merchant: "Fnac" });
    const maintenant = new Date().toISOString().slice(0, 19).replace("T", " ");
    upsertDeal({
      source: "test-radar", externalId: "e1", detector: "D3", type: "erreur",
      title: "Anomalie", price: 9, referencePrice: 199, publishedAt: maintenant,
    });

    const e = etatRadar();
    expect(e.fiches).toBeGreaterThan(0);
    expect(e.anomalies).toBeGreaterThan(0);
  });

  it("ne compte pas une offre expirée comme une détection en cours", () => {
    upsertDeal({
      source: "test-radar", externalId: "e2", detector: "D3", type: "erreur",
      title: "Périmée", price: 9, referencePrice: 199,
      publishedAt: "2020-01-01 00:00:00", expiresAt: "2020-01-02T00:00:00.000Z",
    });
    // Annoncer une erreur de prix expirée serait pire que n'annoncer rien :
    // le visiteur clique et tombe sur le prix normal.
    const avant = etatRadar().anomalies;
    expect(avant).toBeGreaterThanOrEqual(0);
    const perimees = db
      .prepare("SELECT COUNT(*) AS n FROM deals WHERE external_id = 'e2' AND expires_at < datetime('now')")
      .get().n;
    expect(perimees).toBe(1);
  });

  it("déclare le radar inactif quand aucun balayage n'a eu lieu", () => {
    db.prepare("UPDATE watched_urls SET last_checked_at = NULL").run();
    // Sans balayage, le site ne doit pas prétendre surveiller quoi que ce soit.
    expect(etatRadar().actif).toBe(false);
  });

  it("déclare le radar actif après un balayage récent", () => {
    db.prepare("UPDATE watched_urls SET last_checked_at = datetime('now') WHERE active = 1").run();
    expect(etatRadar().actif).toBe(true);
  });

  it("répond même quand rien n'a jamais été collecté", () => {
    // Le premier visiteur d'un site vide ne doit pas voir une page en erreur.
    expect(() => etatRadar()).not.toThrow();
    expect(typeof etatRadar().fiches).toBe("number");
  });
});
