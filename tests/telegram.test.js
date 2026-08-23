// Publication automatique sur le canal Telegram.
//
// Ce module ne détecte rien : il lit ce que `deals` contient déjà. Les tests
// portent donc sur la sélection, la déduplication et la forme du message —
// pas sur la qualité des offres, qui se joue ailleurs.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const telegram = require("../src/telegram.js");
const store = require("../src/dealsStore.js");
const { db } = require("../src/db.js");

/** Une offre publiée, spécialisée par chaque test. */
function offre(over = {}) {
  const { payload, ...reste } = over;
  const id = store.upsertDeal({
    source: "tg-test",
    externalId: `x-${Math.random()}`,
    detector: "D3",
    type: "promo",
    title: "Casque Sony WH-1000XM5",
    merchant: "Boulanger",
    price: 199,
    referencePrice: 399,
    discountPct: 50,
    payload: payload || {},
    ...reste,
  });
  store.publierDeal(id);
  return id;
}

beforeEach(() => {
  db.exec("DELETE FROM telegram_posts; DELETE FROM deals;");
  process.env.TELEGRAM_BOT_TOKEN = "jeton-de-test";
  process.env.TELEGRAM_ENABLED = "true";
  process.env.TELEGRAM_DRY_RUN = "true";
  process.env.TELEGRAM_DELAY_MINUTES = "0";
  process.env.TELEGRAM_MIN_SELLERS = "0";
  // Sans ça, chaque message attend quatre secondes et la suite dure une minute.
  process.env.TELEGRAM_SPACING_MS = "0";
});
afterEach(() => {
  for (const v of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ENABLED", "TELEGRAM_DRY_RUN",
                   "TELEGRAM_DELAY_MINUTES", "TELEGRAM_MIN_SELLERS", "TELEGRAM_DAILY_CAP",
                   "TELEGRAM_SPACING_MS"]) {
    delete process.env[v];
  }
  vi.unstubAllGlobals();
});

describe("sélection", () => {
  it("retient une offre qui passe tous les seuils", () => {
    offre();
    expect(telegram.candidats().length).toBe(1);
  });

  it("écarte une remise trop faible, un prix trop bas, une offre expirée", () => {
    offre({ discountPct: 10 });
    offre({ price: 4, discountPct: 60 });
    offre({ expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(telegram.candidats()).toHaveLength(0);
  });

  it("laisse aux inscrits leur avance sur le canal public", () => {
    process.env.TELEGRAM_DELAY_MINUTES = "30";
    offre(); // détectée à l'instant
    expect(telegram.candidats()).toHaveLength(0);
  });

  it("met le prix le plus bas jamais vu en tête", () => {
    offre({ title: "Écart plus fort", discountPct: 70 });
    offre({ title: "Plus bas jamais vu", discountPct: 40, payload: { allTimeLow: true } });
    expect(telegram.candidats()[0].title).toBe("Plus bas jamais vu");
  });
});

describe("déduplication", () => {
  it("ne republie pas le même produit deux cycles de suite", async () => {
    offre();
    process.env.TELEGRAM_DRY_RUN = "false";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 11 } }),
    })));

    expect((await telegram.publierNouveautes()).publies).toBe(1);
    // Deuxième cycle : le produit est déjà passé, rien ne repart.
    expect((await telegram.publierNouveautes()).publies).toBe(0);
  });

  it("survit à un redémarrage : la table porte la mémoire, pas le processus", () => {
    const id = offre();
    const d = db.prepare("SELECT product_key, price FROM deals WHERE id = ?").get(id);
    db.prepare("INSERT INTO telegram_posts (product_key, deal_id, price_cents) VALUES (?, ?, ?)")
      .run(d.product_key, id, Math.round(d.price * 100));
    expect(telegram.candidats()).toHaveLength(0);
  });

  it("republie si le prix a vraiment rebaissé, et pas avant 48 h", () => {
    const id = offre({ price: 100 });
    const d = db.prepare("SELECT product_key FROM deals WHERE id = ?").get(id);
    // Publié à 200 € il y a trois jours : 100 € est bien 50 % sous.
    db.prepare(
      "INSERT INTO telegram_posts (product_key, deal_id, price_cents, posted_at) VALUES (?, ?, ?, datetime('now','-3 days'))"
    ).run(d.product_key, id, 20000);
    expect(telegram.candidats()).toHaveLength(1);

    // Même baisse, mais publiée il y a une heure : trop tôt.
    db.exec("DELETE FROM telegram_posts");
    db.prepare(
      "INSERT INTO telegram_posts (product_key, deal_id, price_cents, posted_at) VALUES (?, ?, ?, datetime('now','-1 hours'))"
    ).run(d.product_key, id, 20000);
    expect(telegram.candidats()).toHaveLength(0);
  });
});

describe("message", () => {
  it("échappe ce que Telegram interpréterait comme du balisage", () => {
    const texte = telegram.formaterMessage({
      title: "Écran 27\" <Samsung> & LG", price: 199, reference_price: 399,
      discount_pct: 50, merchant: "Fnac & Cie", marchandsComparés: 0,
    });
    expect(texte).toContain("&lt;Samsung&gt;");
    expect(texte).toContain("Fnac &amp; Cie");
    // Les balises voulues, elles, restent intactes.
    expect(texte).toMatch(/<b>.*<\/b>/);
  });

  it("mène à la fiche RadarPrix, jamais au marchand", () => {
    const url = telegram.lienFiche({ title: "Casque Sony" });
    expect(url).toMatch(/\/produit\/Casque%20Sony/);
    expect(url).toContain("utm_source=telegram");
    expect(url).not.toMatch(/boulanger|amazon/i);
  });

  it("n'annonce une médiane que si plusieurs marchands l'ont pratiquée", () => {
    /* La spec prévoyait « Médiane sur N vendeurs » en toutes circonstances.
       Aucune offre publiée n'a plus d'un marchand comparé : l'écrire serait
       inventer une comparaison qui n'a pas eu lieu. */
    expect(telegram.provenance({ marchandsComparés: 3 })).toMatch(/chez 3 marchands/);
    expect(telegram.provenance({ marchandsComparés: 0, refSource: "flux" }))
      .toBe("Prix barré annoncé par le marchand");
    expect(telegram.provenance({ marchandsComparés: 1, baseReference: "marchand" }))
      .toMatch(/avant la baisse/);
    expect(telegram.provenance({ marchandsComparés: 0 })).toBeNull();
  });
});

describe("robustesse", () => {
  it("ne fait rien, proprement, sans jeton", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    offre();
    expect((await telegram.publierNouveautes()).mode).toBe("désactivé");
  });

  it("en simulation, n'appelle pas Telegram", async () => {
    offre();
    const appel = vi.fn();
    vi.stubGlobal("fetch", appel);
    const bilan = await telegram.publierNouveautes();
    expect(bilan.publies).toBe(1);
    expect(appel).not.toHaveBeenCalled();
    // Et rien n'est inscrit : une simulation ne consomme pas le quota.
    expect(telegram.postsDuJour()).toBe(0);
  });

  it("survit à une erreur Telegram sans la propager au scan", async () => {
    offre();
    process.env.TELEGRAM_DRY_RUN = "false";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 401, json: async () => ({ ok: false, description: "Unauthorized" }),
    })));
    const bilan = await telegram.publierNouveautes();
    expect(bilan.erreurs).toBe(1);
    expect(bilan.publies).toBe(0);
  });

  it("respecte le plafond journalier même avec cinquante candidats", async () => {
    process.env.TELEGRAM_DAILY_CAP = "3";
    process.env.TELEGRAM_DRY_RUN = "false";
    for (let i = 0; i < 50; i++) offre({ title: `Produit numéro ${i}` });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }),
    })));
    expect((await telegram.publierNouveautes()).publies).toBe(3);
  });

  it("attend ce que Telegram demande sur une limite de débit", async () => {
    offre();
    process.env.TELEGRAM_DRY_RUN = "false";
    let appels = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      appels++;
      if (appels === 1) {
        return { ok: false, status: 429, json: async () => ({ ok: false, parameters: { retry_after: 0 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    }));
    const bilan = await telegram.publierNouveautes();
    expect(appels).toBe(2);
    expect(bilan.publies).toBe(1);
  });
});
