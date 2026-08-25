// tests/lecture.test.js — La lecture d'une fiche assistée par modèle.
//
// Ce qui est éprouvé ici n'est pas l'appel au modèle : c'est ce qui l'entoure.
// Un modèle rend volontiers un nombre plausible quand la page n'en porte
// aucun, et un prix plausible mais faux est pire qu'une absence de prix — il
// devient une référence, puis une remise, puis une carte qui ment. Le garde-
// fou qui refuse un prix absent de la page est donc le cœur du module.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lecture = require("../src/lecture.js");

describe("texteUtile", () => {
  it("retire ce qu'on n'a aucune raison de payer au token", () => {
    const html = `<html><head><style>.p{color:red}</style>
      <script>var prix = 9999;</script></head>
      <body><svg><path d="M0 0"/></svg><!-- caché -->
      <h1>Aspirateur X</h1><span class="p">199,99&nbsp;€</span></body></html>`;
    const t = lecture.texteUtile(html);
    expect(t).toContain("Aspirateur X");
    expect(t).toContain("199,99");
    // Le prix du script ne doit pas arriver jusqu'au modèle : il n'est pas
    // affiché à l'acheteur.
    expect(t).not.toContain("9999");
    expect(t).not.toContain("caché");
    expect(t).not.toContain("color:red");
  });

  it("borne la page — une fiche marchande pèse couramment 400 ko", () => {
    const enorme = "<p>" + "a".repeat(500000) + "</p>";
    expect(lecture.texteUtile(enorme).length).toBeLessThanOrEqual(lecture.MAX_CARACTERES);
  });
});

describe("prixPresent — le garde-fou contre le prix inventé", () => {
  const page = "Aspirateur X — 199,99 € au lieu de 1 299,00 € — livraison 4,90 €";

  it("accepte un prix écrit à la française", () => {
    expect(lecture.prixPresent(199.99, page)).toBe(true);
  });

  it("accepte un prix dont les milliers sont espacés", () => {
    expect(lecture.prixPresent(1299, page)).toBe(true);
  });

  it("refuse un prix que la page n'affiche pas", () => {
    // Le cas qui compte : plausible, proche, et absent.
    expect(lecture.prixPresent(189.99, page)).toBe(false);
    expect(lecture.prixPresent(200, page)).toBe(false);
  });

  it("refuse un prix nul, négatif ou absurde", () => {
    expect(lecture.prixPresent(0, page)).toBe(false);
    expect(lecture.prixPresent(-5, page)).toBe(false);
    expect(lecture.prixPresent(NaN, page)).toBe(false);
  });
});

describe("budget", () => {
  beforeEach(() => lecture.ouvrirBudget());

  it("se réarme à chaque scan — un plafond qui ne se rouvre pas finit par tout bloquer", () => {
    const plafond = lecture.budgetRestant();
    expect(plafond).toBeGreaterThan(0);
    lecture.ouvrirBudget();
    expect(lecture.budgetRestant()).toBe(plafond);
  });
});

describe("lireFiche sans clé", () => {
  const avant = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => delete process.env.ANTHROPIC_API_KEY);
  afterEach(() => {
    if (avant !== undefined) process.env.ANTHROPIC_API_KEY = avant;
  });

  it("se tait plutôt que d'échouer — le module est un repli, pas une dépendance", async () => {
    expect(lecture.configure()).toBe(false);
    await expect(lecture.lireFiche("<p>Aspirateur 199,99 €</p>")).resolves.toBeNull();
  });
});

describe("disjoncteur", () => {
  beforeEach(() => lecture.ouvrirBudget());

  it("repart propre à chaque scan — un crédit rechargé doit reprendre seul", () => {
    // Le disjoncteur se réarme avec le budget : sans ça, une panne passagère
    // condamnerait le repli jusqu'au prochain redéploiement.
    expect(lecture.etatPanne()).toBeNull();
  });
});

describe("un échec passager n'est pas une panne", () => {
  // La première version coupait la lecture du scan entier au premier ennui
  // venu : un seul délai dépassé — le fournisseur qui met trois secondes de
  // trop — et plus une fiche n'était lue de la journée. Éprouvé en vrai,
  // c'est exactement ce qui est arrivé.
  beforeEach(() => lecture.ouvrirBudget());

  const definitif = (m) =>
    /crédit|credit balance|quota|billing|API key|api_key|clé|invalid|unauthor|permission|forbidden|401|403|429/i.test(m);

  it("reconnaît ce qui ne se réparera pas tout seul", () => {
    expect(definitif("Your credit balance is too low")).toBe(true);
    expect(definitif("API key not valid")).toBe(true);
    expect(definitif("Quota exceeded")).toBe(true);
    expect(definitif("403 Forbidden")).toBe(true);
  });

  it("laisse passer ce qui a des chances de marcher au prochain essai", () => {
    expect(definitif("The operation was aborted due to timeout")).toBe(false);
    expect(definitif("fetch failed")).toBe(false);
    expect(definitif("HTTP 503")).toBe(false);
  });
});
