// lecture.js — Lire un prix sur une fiche produit quand le balisage se tait.
//
// POURQUOI CE MODULE EXISTE
//
// Mesuré le 24 août 2026 par la sonde, depuis l'IP qui collecte : sur les
// quatre-vingt-quatre enseignes du registre, treize se laissent parcourir ET
// lire. **Onze de plus se laissent parcourir mais pas lire** — Aldi, Free,
// Ikea, Leroy Merlin, Kiabi, Vinted, Marionnaud, Nocibé, Momox, Feu Vert,
// Midas. Leurs sitemaps répondent, leurs pages arrivent entières, et
// `extraction.js` n'y trouve rien : ni JSON-LD schema.org, ni microdata, ni
// OpenGraph exploitable.
//
// Ceux-là ne demandent aucun proxy. Ils demandent une meilleure lecture.
//
// TROIS RÈGLES, ET AUCUNE N'EST NÉGOCIABLE
//
//  1. On n'appelle jamais le modèle quand le balisage a déjà répondu.
//     `extraction.js` passe d'abord, toujours. Le modèle est un REPLI, et un
//     repli qui se déclenche à tort coûte de l'argent à chaque fiche, huit
//     fois par jour, sur chaque marchand.
//
//  2. On n'enregistre jamais un prix que le modèle a inventé. Le prix rendu
//     doit se retrouver TEL QUEL dans le texte de la page. Un modèle qui
//     hallucine un prix plausible est exactement le bug du prix de référence
//     fabriqué — celui qui a affiché des « −67 % » imaginaires — avec une
//     machine plus chère pour le produire.
//
//  3. On borne la dépense. Un plafond d'appels par scan, et la page est
//     réduite avant d'être envoyée : une fiche marchande pèse couramment
//     400 ko dont 90 % de script et de style, qu'il n'y a aucune raison de
//     payer au token.
//
// La clé (`ANTHROPIC_API_KEY`) reste côté serveur, comme toutes les autres.
// Sans elle le module se tait et rien ne casse.

const Anthropic = require("@anthropic-ai/sdk");

/* DEUX FOURNISSEURS, UN SEUL FILET DE SÉCURITÉ
 *
 * Anthropic et Gemini savent tous deux rendre du JSON sous schéma strict.
 * Ce qui change entre eux est l'appel ; ce qui ne change pas — et ne doit
 * jamais changer — est la vérification qui suit : le prix rendu doit se
 * retrouver dans le texte de la page, sans quoi il est refusé. Un fournisseur
 * n'est jamais cru sur parole.
 *
 * Le choix par défaut va à celui dont la clé est posée. Quand les deux le
 * sont, Gemini passe devant : son enveloppe gratuite couvre largement nos
 * quarante fiches par scan, et payer pour la même tâche serait un choix, pas
 * une évidence. `LECTURE_FOURNISSEUR` tranche explicitement si besoin. */
const cle = (nom) => String(process.env[nom] || "").trim();

function fournisseur() {
  const choisi = String(process.env.LECTURE_FOURNISSEUR || "").trim().toLowerCase();
  if (choisi === "gemini" || choisi === "anthropic") return choisi;
  if (cle("GEMINI_API_KEY")) return "gemini";
  if (cle("ANTHROPIC_API_KEY")) return "anthropic";
  return null;
}

/* Les modèles par défaut. La lecture d'une fiche produit ne demande pas le
   haut de gamme ; descendre ou monter reste un arbitrage de coût, donc une
   décision d'exploitant, pas une décision du code.

   « gemini-2.5-flash-lite » n'est plus servi aux nouveaux comptes — l'API
   le dit elle-même et renvoie 404. L'alias « latest » évite de se réveiller
   un matin avec un modèle retiré. */
const MODELE = () =>
  process.env.LECTURE_MODELE ||
  (fournisseur() === "gemini" ? "gemini-flash-lite-latest" : "claude-opus-5");

/* Combien de fiches au plus on accepte de faire lire par le modèle pendant
   un scan. Sans plafond, un marchand dont le balisage casse du jour au
   lendemain enverrait ses soixante fiches à chaque passage, huit fois par
   jour. */
const PLAFOND_PAR_SCAN = () => parseInt(process.env.LECTURE_PLAFOND || "40", 10);

/* Ce qu'on accepte d'envoyer d'une page. Vingt mille caractères couvrent
   très largement la zone où un prix s'affiche, une fois le bruit retiré. */
const MAX_CARACTERES = 20000;

const configure = () => fournisseur() !== null;

let client = null;
const clientAnthropic = () => {
  if (!client) client = new Anthropic();
  return client;
};

/* Le schéma est strict et fermé : le modèle ne peut rendre que ces champs,
   et `null` est explicitement permis là où l'information peut manquer.
   Laisser le modèle libre de sa forme, c'est se condamner à parser du texte
   — exactement ce qu'on essaie d'arrêter de faire. */
const SCHEMA = {
  type: "object",
  properties: {
    nom: { type: ["string", "null"], description: "Nom du produit tel qu'il est écrit sur la page" },
    prix: { type: ["number", "null"], description: "Prix de vente actuel, en euros, tel qu'affiché" },
    prixReference: {
      type: ["number", "null"],
      description: "Prix barré ou prix conseillé, en euros. null si la page n'en affiche aucun",
    },
    disponible: { type: ["boolean", "null"], description: "L'article est-il annoncé disponible" },
    fiche: {
      type: "boolean",
      description: "Vrai seulement si la page est une fiche produit — faux pour une catégorie, un panier, une page d'accueil",
    },
  },
  required: ["nom", "prix", "prixReference", "disponible", "fiche"],
  additionalProperties: false,
};

const CONSIGNE = [
  "Tu lis le texte d'une page de site marchand français et tu en extrais le prix.",
  "",
  "Règles :",
  "— Le prix de vente est celui que l'acheteur paie aujourd'hui, pas le prix barré.",
  "— Le prix barré, prix conseillé ou « au lieu de » va dans prixReference. Si la page",
  "  n'en affiche aucun, prixReference vaut null. N'en déduis jamais un.",
  "— N'invente rien : si un champ ne figure pas sur la page, rends null.",
  "— Ne calcule aucun prix. Recopie celui qui est écrit.",
  "— Si la page n'est pas une fiche produit (catégorie, résultats de recherche,",
  "  panier, accueil), mets fiche à false et tous les autres champs à null.",
  "— Les prix français s'écrivent « 1 299,99 € » : rends 1299.99.",
].join("\n");

/**
 * Réduit une page à ce qui peut porter un prix.
 *
 * Une fiche marchande pèse couramment quatre cents kilo-octets dont
 * l'écrasante majorité est du script, du style et du SVG. Les envoyer
 * reviendrait à payer au token une soupe que le modèle devrait de toute
 * façon écarter.
 */
function texteUtile(html) {
  return String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:eacute|#233);/gi, "é")
    .replace(/&(?:egrave|#232);/gi, "è")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CARACTERES);
}

/* Le garde-fou vit dans extraction.js : c'est la même question — « ce prix
   s'affiche-t-il vraiment ? » — posée par l'état applicatif embarqué et par
   le modèle. Une seule implémentation, un seul jeu de tests. */
const { prixPresent } = require("./extraction");

/**
 * Lit une fiche produit avec le modèle.
 *
 * @param {string} html page entière, telle que le marchand l'a servie
 * @returns {Promise<null|{nom:string, prix:number, prixReference:number|null, disponible:boolean|null}>}
 *   null quand la clé manque, quand la page n'est pas une fiche, ou quand le
 *   prix rendu ne se retrouve pas dans la page.
 */
/* Le même schéma, dans le dialecte de Gemini. Il n'accepte pas
   `type: ["number","null"]` : il faut `nullable: true`. Traduire à la volée
   serait une source d'erreur silencieuse — un champ mal déclaré et le modèle
   rend ce qu'il veut. On l'écrit donc en toutes lettres. */
const SCHEMA_GEMINI = {
  type: "OBJECT",
  properties: {
    nom: { type: "STRING", nullable: true },
    prix: { type: "NUMBER", nullable: true },
    prixReference: { type: "NUMBER", nullable: true },
    disponible: { type: "BOOLEAN", nullable: true },
    fiche: { type: "BOOLEAN" },
  },
  required: ["nom", "prix", "prixReference", "disponible", "fiche"],
};

/** Appelle Anthropic. Rend le texte JSON, ou lève. */
async function appelerAnthropic(texte) {
  const reponse = await clientAnthropic().messages.create({
    model: MODELE(),
    max_tokens: 1000,
    // Une extraction n'a pas besoin de longues délibérations, et l'effort
    // est ce qui pèse le plus sur la facture d'un appel répété soixante fois.
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: CONSIGNE,
    messages: [{ role: "user", content: texte }],
  });
  /* La mise en cache du préfixe n'est pas branchée, et c'est délibéré : elle
     demande au moins mille tokens stables en tête de requête, or notre
     consigne est bien plus courte. L'activer ne ferait rien, en silence. */
  return reponse.content.find((b) => b.type === "text")?.text || null;
}

/** Appelle Gemini par son API REST. Rend le texte JSON, ou lève. */
async function appelerGemini(texte) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELE()}:generateContent` +
    `?key=${encodeURIComponent(cle("GEMINI_API_KEY"))}`;
  const rep = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(45000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: CONSIGNE }] },
      contents: [{ role: "user", parts: [{ text: texte }] }],
      generationConfig: {
        // Zéro : on relève un prix écrit sur une page, il n'y a rien à
        // inventer et deux passages sur la même fiche doivent s'accorder.
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: SCHEMA_GEMINI,
      },
    }),
  });
  const data = await rep.json().catch(() => null);
  if (!rep.ok || data?.error) {
    throw new Error(data?.error?.message || `Gemini : HTTP ${rep.status}`);
  }
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

async function lireFiche(html) {
  if (!configure()) return null;
  const texte = texteUtile(html);
  if (texte.length < 200) return null;

  let brut;
  try {
    /* Le budget se décompte ICI, au moment où un appel part vraiment — et
       non à l'entrée de `lireSousBudget`. Une page trop courte pour valoir
       un appel consommait quand même une unité du plafond : quarante pages
       vides suffisaient à épuiser le budget d'un scan sans qu'un seul mot
       ait été envoyé. */
    lues++;
    brut = fournisseur() === "gemini" ? await appelerGemini(texte) : await appelerAnthropic(texte);
  } catch (e) {
    /* Une panne d'API n'est PAS une page illisible, et les confondre coûte
       cher dans les deux sens : on croit le marchand muet alors qu'il est
       lisible, et on relance quarante appels par scan qui échoueront tous
       de la même façon.

       Le premier essai en production l'a montré : la clé était valide, le
       compte sans crédit, et rien dans le journal ne le disait — onze
       marchands « aucune fiche lisible », pas un mot sur la cause. */
    signalerPanne(e);
    return null;
  }
  signalerSucces();
  if (!brut) return null;

  let lu;
  try {
    lu = JSON.parse(brut);
  } catch {
    return null;
  }

  if (!lu || lu.fiche !== true) return null;
  if (!prixPresent(lu.prix, texte)) return null;
  // Une référence qui n'est pas sur la page, ou qui ne dépasse pas le prix
  // payé, ne prouve aucune remise : on la laisse tomber plutôt que de
  // l'afficher barrée.
  const ref =
    Number.isFinite(lu.prixReference) &&
    lu.prixReference > lu.prix &&
    prixPresent(lu.prixReference, texte)
      ? lu.prixReference
      : null;

  return {
    nom: typeof lu.nom === "string" ? lu.nom.slice(0, 200) : null,
    prix: lu.prix,
    prixReference: ref,
    disponible: typeof lu.disponible === "boolean" ? lu.disponible : null,
  };
}

/* Une panne coupe le repli pour le reste du scan.

   Sans ce disjoncteur, une clé sans crédit ou révoquée fait partir un appel
   par fiche — quarante allers-retours par scan, huit fois par jour, pour
   quarante fois la même erreur. La panne se dit une fois, puis on se tait
   jusqu'au scan suivant, qui réessaiera. */
let panne = null;
let echecsDeSuite = 0;

/* Un échec passager n'est pas une panne. La première version coupait la
   lecture du scan entier au premier ennui venu : un seul délai dépassé — le
   fournisseur qui met trois secondes de trop — et plus une fiche n'était lue
   de la journée. Éprouvé en vrai, c'est exactement ce qui est arrivé.
   
   On sépare donc ce qui ne se réparera pas tout seul de ce qui passera. */
const DEFINITIF = /crédit|credit balance|quota|billing|API key|api_key|clé|invalid|unauthor|permission|forbidden|401|403|429/i;
const ECHECS_TOLERES = 3;

function signalerPanne(e) {
  const message =
    (e && e.error && e.error.error ? e.error.error.message : e.message) || "erreur inconnue";

  if (DEFINITIF.test(message)) {
    // Clé refusée, crédit épuisé, quota atteint : réessayer quarante fois
    // ne fera que répéter la même réponse. On coupe tout de suite.
    if (!panne) console.error(`[lecture] coupée pour ce scan — ${message}`);
    panne = message;
    return;
  }

  echecsDeSuite++;
  if (echecsDeSuite >= ECHECS_TOLERES) {
    if (!panne) {
      console.error(`[lecture] coupée après ${echecsDeSuite} échecs de suite — ${message}`);
    }
    panne = message;
  } else {
    console.warn(`[lecture] échec ${echecsDeSuite}/${ECHECS_TOLERES} — ${message}`);
  }
}

/** Une lecture réussie efface l'ardoise : les échecs comptés doivent être CONSÉCUTIFS. */
const signalerSucces = () => {
  echecsDeSuite = 0;
};

/** Ce qui a coupé la lecture, ou null si tout va bien. */
const etatPanne = () => panne;

/* Le compteur du scan en cours. Remis à zéro par `ouvrirBudget`, appelé au
   début de chaque scan : un plafond qui ne se réarme jamais finirait par
   tout bloquer. */
let lues = 0;
const ouvrirBudget = () => {
  lues = 0;
  echecsDeSuite = 0;
  // Le disjoncteur se réarme aussi : un crédit rechargé entre deux scans
  // doit reprendre tout seul, sans redéploiement.
  panne = null;
};
const budgetRestant = () => Math.max(0, PLAFOND_PAR_SCAN() - lues);

/** Comme `lireFiche`, mais rend null dès que le plafond du scan est atteint. */
async function lireSousBudget(html) {
  if (panne) return null;
  if (budgetRestant() <= 0) return null;
  return lireFiche(html);
}

module.exports = {
  configure,
  fournisseur,
  MODELE,
  etatPanne,
  lireFiche,
  lireSousBudget,
  ouvrirBudget,
  budgetRestant,
  texteUtile,
  prixPresent,
  SCHEMA,
  MAX_CARACTERES,
};
