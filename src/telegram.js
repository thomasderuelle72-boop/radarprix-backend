// telegram.js — Publication automatique des deals sur le canal Telegram.
//
// Le module vit à côté du moteur de détection, jamais dedans : il LIT ce que
// `deals` contient déjà et n'a aucune opinion sur ce qui mérite d'être
// détecté. C'est ce qui permet de le désactiver, de le casser ou de le
// retirer sans que le scan s'en aperçoive.
//
// POURQUOI fetch PLUTÔT QU'UNE LIBRAIRIE
// On n'appelle qu'un seul endpoint (sendMessage). `node-telegram-bot-api`
// embarque un serveur de polling, une machine à états de conversation et ses
// dépendances — tout ce dont on n'a pas l'usage. Le dépôt appelle déjà
// Firecrawl et Awin en fetch brut.
const { db } = require("./db");
/* dealsStore crée la table `deals` que ce module interroge. Le serveur le
   charge de toute façon avant nous, mais un script lancé seul — la
   simulation, un cron — plantait sur « no such table: deals ». Une
   dépendance implicite au bon ordre de chargement n'en est pas une. */
require("./dealsStore");

const API = "https://api.telegram.org";
const SITE = process.env.SITE_URL || "https://radarprix.fr";

/* Chaque envoi est espacé : l'API tolère une vingtaine de messages par
   minute vers un même canal, on garde de la marge. Réglable parce qu'une
   suite de tests qui attend quatre secondes par message met une demi-minute
   à s'exécuter — et une suite lente cesse d'être lancée. */
const ESPACEMENT_MS = () => {
  const v = parseInt(process.env.TELEGRAM_SPACING_MS, 10);
  return Number.isFinite(v) ? v : 4000;
};
const TENTATIVES_MAX = 3;

db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- La clé PRODUIT, pas l'identifiant d'une ligne de deals : c'est elle qui
    -- fait marcher la règle « même produit, nouveau prix ». Il n'existe pas
    -- de table produits dans ce dépôt ; product_key est la clé d'identité
    -- déjà employée par l'historique des prix (voir productKey.js).
    product_key TEXT NOT NULL,
    deal_id INTEGER,
    -- En centimes : comparer des flottants pour décider d'une republication
    -- ferait republier sur un écart d'arrondi.
    price_cents INTEGER NOT NULL,
    message_id INTEGER,
    posted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_telegram_posts_produit ON telegram_posts(product_key);
  CREATE INDEX IF NOT EXISTS idx_telegram_posts_date ON telegram_posts(posted_at);
`);

/** Lecture d'un entier d'environnement, avec repli si absent ou illisible. */
const entier = (nom, defaut) => {
  const v = parseInt(process.env[nom], 10);
  return Number.isFinite(v) ? v : defaut;
};
const booleen = (nom, defaut) => {
  const v = String(process.env[nom] || "").trim().toLowerCase();
  if (!v) return defaut;
  return v === "true" || v === "1" || v === "oui";
};

/** Réglages relus à chaque appel : Railway redéploie, l'env peut changer. */
function reglages() {
  return {
    token: process.env.TELEGRAM_BOT_TOKEN || "",
    canal: process.env.TELEGRAM_CHANNEL_ID || "-1003927419198",
    actif: booleen("TELEGRAM_ENABLED", false),
    simulation: booleen("TELEGRAM_DRY_RUN", true),
    delaiMinutes: entier("TELEGRAM_DELAY_MINUTES", 30),
    capJournalier: entier("TELEGRAM_DAILY_CAP", 15),
    remiseMin: entier("TELEGRAM_MIN_DISCOUNT_PCT", 25),
    /* Zéro, et non trois comme envisagé au départ. Mesuré sur les 71 offres
       publiées : AUCUNE n'a plus d'un marchand comparé, parce qu'un catalogue
       marchand n'a qu'un vendeur par produit et qu'un prix barré d'agrégateur
       n'est pas une médiane. À trois, le module ne publierait jamais rien.
       Le réglage reste là pour le jour où Awin apportera plusieurs
       marchands sur un même article. */
    vendeursMin: entier("TELEGRAM_MIN_SELLERS", 0),
    prixMin: entier("TELEGRAM_MIN_PRICE_EUR", 15),
  };
}

/** Ce que le tableau de bord affiche en tête de section. */
function etat() {
  const r = reglages();
  return {
    mode: !r.actif || !r.token ? "désactivé" : r.simulation ? "simulation" : "actif",
    canal: r.canal,
    postsAujourdHui: postsDuJour(),
    capJournalier: r.capJournalier,
    reglages: { ...r, token: r.token ? "défini" : "absent" },
  };
}

function postsDuJour() {
  return db
    .prepare("SELECT COUNT(*) AS n FROM telegram_posts WHERE date(posted_at) = date('now')")
    .get().n;
}

// ── Sélection ───────────────────────────────────────────────────

/**
 * Les offres qui méritent le canal, les meilleures d'abord.
 *
 * On ne lit que des colonnes et des champs déjà calculés par le moteur :
 * ce module ne recalcule ni médiane, ni historique, ni « prix le plus bas ».
 */
function candidats(limite = 50) {
  const r = reglages();
  const lignes = db
    .prepare(
      `SELECT d.*, tp.price_cents AS dernier_prix_publie, tp.posted_at AS derniere_publication
         FROM deals d
         LEFT JOIN (
           SELECT product_key, price_cents, posted_at,
                  ROW_NUMBER() OVER (PARTITION BY product_key ORDER BY posted_at DESC) AS rang
             FROM telegram_posts
         ) tp ON tp.product_key = d.product_key AND tp.rang = 1
        WHERE d.published_at IS NOT NULL
          AND d.removed_at IS NULL
          AND d.price >= ?
          AND d.discount_pct >= ?
          AND (d.expires_at IS NULL OR d.expires_at > datetime('now'))
          -- Les inscrits sont prévenus avant le canal public : c'est
          -- l'argument d'inscription, pas un effet de bord.
          AND d.first_seen_at <= datetime('now', ?)
        ORDER BY d.discount_pct DESC
        LIMIT ?`
    )
    .all(r.prixMin, r.remiseMin, `-${r.delaiMinutes} minutes`, limite * 4);

  return lignes
    .map(enrichir)
    .filter((d) => d.marchandsComparés >= r.vendeursMin)
    .filter(republicationPermise)
    /* Le badge « prix le plus bas jamais vu » passe devant : c'est le seul
       signal qui repose sur l'historique du produit et non sur une remise
       annoncée. Ensuite l'écart, décroissant. */
    .sort((a, b) => (b.allTimeLow ? 1 : 0) - (a.allTimeLow ? 1 : 0) || b.discount_pct - a.discount_pct)
    .slice(0, limite);
}

/** Décode le payload une fois, plutôt qu'à chaque lecture d'un champ. */
function enrichir(ligne) {
  let p = {};
  try {
    p = JSON.parse(ligne.payload || "{}");
  } catch {
    p = {};
  }
  return {
    ...ligne,
    allTimeLow: Boolean(p.allTimeLow),
    marchandsComparés: p.marchandsComparés || 0,
    baseReference: p.baseReference || null,
    refSource: p.refSource || null,
  };
}

/**
 * Un produit déjà publié ne revient que s'il a VRAIMENT rebaissé.
 *
 * Deux conditions cumulées, pour qu'un canal ne devienne pas un flux de
 * répétitions : au moins 5 % sous le dernier prix publié, et 48 heures
 * écoulées. La table survit aux redémarrages, donc un redéploiement de
 * Railway ne provoque pas de doublon.
 */
function republicationPermise(d) {
  if (!d.dernier_prix_publie) return true;
  const assezBas = d.price * 100 <= d.dernier_prix_publie * 0.95;
  const assezVieux =
    db
      .prepare("SELECT (julianday('now') - julianday(?)) * 24 AS heures")
      .get(d.derniere_publication).heures >= 48;
  return assezBas && assezVieux;
}

// ── Message ─────────────────────────────────────────────────────

/** HTML de Telegram : seuls ces trois caractères sont à échapper. */
const echapper = (t) =>
  String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const euros = (n) => `${Number(n).toFixed(2).replace(".", ",")} €`;

/**
 * Le lien mène à la fiche RadarPrix, jamais au marchand : c'est tout
 * l'intérêt de publier. La page porte ses balises OpenGraph, donc Telegram
 * en tire un aperçu.
 */
function lienFiche(d) {
  const utm = "utm_source=telegram&utm_medium=social&utm_campaign=auto";
  return `${SITE}/produit/${encodeURIComponent(d.title)}?${utm}`;
}

/**
 * D'où vient le prix barré, dit honnêtement.
 *
 * La spec prévoyait « Médiane sur N vendeurs ». Aucune offre publiée n'a
 * plus d'un marchand comparé : l'écrire serait inventer une comparaison qui
 * n'a pas eu lieu — exactement le défaut corrigé sur les cartes du site.
 */
function provenance(d) {
  if (d.marchandsComparés >= 2) return `Prix habituel constaté chez ${d.marchandsComparés} marchands`;
  if (d.refSource === "flux") return "Prix barré annoncé par le marchand";
  if (d.baseReference === "marchand") return "Prix pratiqué par ce marchand avant la baisse";
  return null;
}

function formaterMessage(d) {
  const lignes = [`🔻 <b>${echapper(d.title)}</b>`, ""];

  const prix = `<b>${echapper(euros(d.price))}</b>`;
  const barre = d.reference_price > d.price ? `  <s>${echapper(euros(d.reference_price))}</s>` : "";
  const ecart = d.discount_pct > 0 ? `   −${d.discount_pct} %` : "";
  lignes.push(`${prix}${barre}${ecart}`);

  if (d.allTimeLow) lignes.push("🏆 Prix le plus bas jamais vu");
  lignes.push("");

  if (d.merchant) lignes.push(`Vendeur : ${echapper(d.merchant)}`);
  const source = provenance(d);
  if (source) lignes.push(echapper(source));
  lignes.push("");

  lignes.push(`👉 ${lienFiche(d)}`);
  return lignes.join("\n");
}

// ── Envoi ───────────────────────────────────────────────────────

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Envoie un message, en respectant les limites de Telegram.
 *
 * Sur 429, l'API indique elle-même combien de temps attendre dans
 * `retry_after` : on l'écoute plutôt que de deviner, et on double l'attente
 * à chaque nouvelle tentative.
 */
async function envoyer(texte, tentative = 1) {
  const r = reglages();
  const rep = await fetch(`${API}/bot${r.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: r.canal,
      text: texte,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
    signal: AbortSignal.timeout(15000),
  });

  const corps = await rep.json().catch(() => ({}));
  if (rep.ok && corps.ok) return corps.result;

  if (rep.status === 429 && tentative < TENTATIVES_MAX) {
    const attente = (corps.parameters?.retry_after || 5) * 1000 * tentative;
    console.log(`[telegram] limite atteinte, nouvelle tentative dans ${attente / 1000} s`);
    await dormir(attente);
    return envoyer(texte, tentative + 1);
  }
  throw new Error(corps.description || `HTTP ${rep.status}`);
}

const enregistrer = db.prepare(
  `INSERT INTO telegram_posts (product_key, deal_id, price_cents, message_id)
   VALUES (?, ?, ?, ?)`
);

/**
 * Publie les nouvelles offres. NE LÈVE JAMAIS.
 *
 * Appelée en fin de cycle de scan : une panne de Telegram, un token révoqué
 * ou un canal supprimé ne doivent pas faire échouer une collecte qui, elle,
 * a réussi.
 */
async function publierNouveautes() {
  const bilan = { mode: null, examines: 0, publies: 0, erreurs: 0 };
  try {
    const r = reglages();
    if (!r.actif || !r.token) {
      bilan.mode = "désactivé";
      console.log(`[telegram] inactif — ${!r.token ? "TELEGRAM_BOT_TOKEN absent" : "TELEGRAM_ENABLED=false"}`);
      return bilan;
    }

    const restant = Math.max(0, r.capJournalier - postsDuJour());
    if (restant === 0) {
      bilan.mode = "cap atteint";
      console.log(`[telegram] plafond du jour atteint (${r.capJournalier}).`);
      return bilan;
    }

    const lot = candidats(restant);
    bilan.mode = r.simulation ? "simulation" : "actif";
    bilan.examines = lot.length;

    for (const d of lot) {
      try {
        const texte = formaterMessage(d);
        if (r.simulation) {
          console.log(`[telegram] (simulation) message qui serait envoyé :\n${texte}\n`);
          bilan.publies++;
          continue;
        }
        const envoye = await envoyer(texte);
        enregistrer.run(d.product_key, d.id, Math.round(d.price * 100), envoye.message_id || null);
        bilan.publies++;
        await dormir(ESPACEMENT_MS());
      } catch (e) {
        bilan.erreurs++;
        console.error(`[telegram] échec sur « ${d.title} » : ${e.message}`);
      }
    }
    console.log(`[telegram] ${bilan.publies} message(s) ${r.simulation ? "simulé(s)" : "envoyé(s)"}, ${bilan.erreurs} erreur(s).`);
  } catch (e) {
    // Dernier rempart : rien ne remonte au scan.
    bilan.erreurs++;
    console.error(`[telegram] module en échec : ${e.message}`);
  }
  return bilan;
}

/** Les derniers messages publiés, pour le tableau de bord. */
function derniersPosts(limite = 20) {
  return db
    .prepare(
      `SELECT tp.*, d.title, d.merchant, d.discount_pct
         FROM telegram_posts tp
         LEFT JOIN deals d ON d.id = tp.deal_id
        ORDER BY tp.posted_at DESC LIMIT ?`
    )
    .all(limite);
}

/** Publie une offre précise, depuis le tableau de bord. */
async function publierMaintenant(dealId) {
  const ligne = db.prepare("SELECT * FROM deals WHERE id = ?").get(dealId);
  if (!ligne) return { ok: false, error: "Offre introuvable." };

  const d = enrichir(ligne);
  const r = reglages();
  if (!r.actif || !r.token) return { ok: false, error: "Module Telegram désactivé." };

  try {
    const texte = formaterMessage(d);
    if (r.simulation) return { ok: true, simulation: true, texte };
    const envoye = await envoyer(texte);
    enregistrer.run(d.product_key, d.id, Math.round(d.price * 100), envoye.message_id || null);
    return { ok: true, messageId: envoye.message_id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Écarte une offre du canal sans l'envoyer.
 *
 * On l'inscrit comme publiée avec un message_id nul : la déduplication la
 * traitera comme déjà vue, sans qu'aucun message n'existe.
 */
function ignorer(dealId) {
  const d = db.prepare("SELECT id, product_key, price FROM deals WHERE id = ?").get(dealId);
  if (!d) return { ok: false, error: "Offre introuvable." };
  enregistrer.run(d.product_key, d.id, Math.round(d.price * 100), null);
  return { ok: true };
}

module.exports = {
  reglages,
  etat,
  candidats,
  formaterMessage,
  echapper,
  lienFiche,
  provenance,
  publierNouveautes,
  publierMaintenant,
  ignorer,
  derniersPosts,
  postsDuJour,
};
