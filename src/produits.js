// produits.js — Registre d'identité produit.
//
// LE PROBLÈME QU'IL RÉSOUT
//
// Mesuré le 2 septembre 2026 sur la base de production : 8 591 produits
// distincts, dont **5** vus chez au moins deux marchands. Zéro virgule zéro
// six pour cent. Un site qui promet « le même article moins cher ailleurs »
// ne savait, en pratique, jamais dire que deux offres parlent du même article.
//
// Deux causes, toutes deux structurelles :
//
//   1. L'identité reposait sur `productKey()` — l'ensemble EXACT des mots
//      significatifs du titre. Deux enseignes ne titrent jamais pareil :
//      « Casque Sony WH-1000XM5 Bluetooth Noir » chez l'une,
//      « Sony WH1000XM5 casque sans fil réduction de bruit » chez l'autre.
//      Un mot d'écart, une identité de plus.
//
//   2. Le seul identifiant universel — le code-barres — n'arrivait jamais :
//      `extraction.js` rangeait `sku || gtin13 || mpn` dans un champ unique,
//      le SKU en premier. Or le SKU est la référence INTERNE d'une enseigne.
//      On remplissait donc le champ « EAN » de références maison, que
//      `eanValide()` rejetait ensuite. Résultat : 50 relevés porteurs d'un
//      code-barres sur 23 152, et aucun partagé.
//
// LA RÉPONSE
//
// Une cascade de résolution, du plus fort au plus faible. Chaque niveau ne
// s'applique que s'il apporte une certitude ; sinon on descend. Mieux vaut
// deux identités pour un produit qu'une identité pour deux produits : un
// faux rapprochement fabrique une remise imaginaire, et une remise imaginaire
// est exactement ce que ce site existe pour ne pas publier.
//
//   1. EAN/GTIN          — absolu. Le même code désigne le même article
//                          partout dans le monde.
//   2. marque + référence — quasi absolu. Le MPN du fabricant, désambiguïsé
//                          par la marque (deux fabricants peuvent réutiliser
//                          un même numéro).
//   3. empreinte modèle   — les codes modèle du titre (« wh1000xm5 », « 128 »)
//                          plus les suffixes de gamme (« pro », « ultra »),
//                          triés. Ne vaut que si une marque l'accompagne ou
//                          si le code est assez long pour être un vrai
//                          identifiant — « 15 » tout seul ne désigne rien.
//   4. rien               — identité locale, dérivée du titre. C'est le
//                          comportement d'avant, conservé pour que le produit
//                          garde SON historique même sans identifiant.
const { db } = require("./db");
const { significantWords, estMarqueurVariante, productKey } = require("./productKey.js");

db.exec(`
  CREATE TABLE IF NOT EXISTS produits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ean TEXT,
    marque TEXT,
    reference TEXT,
    empreinte TEXT,
    cle_titre TEXT,
    titre TEXT NOT NULL,
    categorie TEXT,
    vu_le TEXT NOT NULL DEFAULT (datetime('now')),
    maj_le TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Index PARTIELS : SQLite les honore, et c'est ce qui permet d'imposer
  -- l'unicité d'un EAN sans interdire les milliers de produits qui n'en ont
  -- pas. Un index unique ordinaire traiterait tous les NULL comme distincts
  -- en SQLite, mais l'index partiel dit surtout l'intention : la contrainte
  -- porte sur les produits identifiés, pas sur les autres.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produits_ean
    ON produits(ean) WHERE ean IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produits_reference
    ON produits(marque, reference) WHERE marque IS NOT NULL AND reference IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_produits_empreinte
    ON produits(empreinte) WHERE empreinte IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_produits_cle_titre ON produits(cle_titre);
`);

/* Un EAN/GTIN fait 8, 12, 13 ou 14 chiffres. Les suites d'un seul chiffre
   répété (« 0000000000000 ») sont des remplissages, pas des codes. */
function eanNormalise(brut) {
  if (brut == null) return null;
  const chiffres = String(brut).replace(/\D/g, "");
  if (!/^\d{8}$|^\d{12,14}$/.test(chiffres)) return null;
  if (/^(\d)\1+$/.test(chiffres)) return null;
  return chiffres;
}

/* Ces mots sont des marques dans un titre, pas des identifiants — mais
   surtout, une marque écrite par un marchand ne l'est jamais par un autre de
   la même façon. On la ramène à ses lettres et chiffres. */
function marqueNormalisee(brut) {
  if (!brut) return null;
  const m = String(brut)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
  return m.length >= 2 ? m.slice(0, 40) : null;
}

function referenceNormalisee(brut) {
  if (!brut) return null;
  const r = String(brut)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  // Trois caractères ne font pas une référence fabricant ; ils font du bruit.
  return r.length >= 4 && r.length <= 40 ? r : null;
}

/* Les unités et mots collés à un chiffre qui ne disent rien du modèle. On ne
   retire PAS les capacités (« 128 », « 256 ») : elles distinguent deux
   articles bel et bien différents, et les confondre fabriquerait exactement
   la fausse remise qu'on cherche à éviter. */
const BRUIT_NUMERIQUE = /^(19|20)\d{2}$/; // une année de sortie ou de copyright

/**
 * L'empreinte modèle d'un titre : ce qu'il reste quand on ôte le marketing.
 *
 * On garde les jetons qui portent un chiffre — un code modèle, une
 * génération, une capacité — et les suffixes de gamme, qui n'en portent pas
 * mais changent le produit (« pro », « ultra », « ti »). Les tirets à
 * l'intérieur d'un code sont recollés : « WH-1000XM5 » et « WH1000XM5 »
 * doivent produire le même jeton, c'est tout l'objet de l'exercice.
 *
 * Rend `null` quand l'empreinte ne prouve rien : « 15 » tout seul peut être
 * un iPhone, un pouce d'écran ou un litre. Il faut donc soit une marque pour
 * l'ancrer, soit un code assez long pour n'appartenir qu'à un article.
 */
function empreinte(nom, marque = null) {
  if (!nom) return null;
  // Recoller les codes coupés : « wh-1000xm5 » → « wh1000xm5 ». Uniquement
  // autour d'un tiret, jamais d'un espace — « Air Max 90 » doit rester trois
  // mots, sans quoi « airmax90 » ne ressemblerait plus à rien de commun.
  const recolle = String(nom)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])-([a-z0-9])/g, "$1$2");

  const mots = significantWords(recolle);
  const modeles = [];
  const variantes = [];
  for (const m of mots) {
    if (/\d/.test(m)) {
      if (BRUIT_NUMERIQUE.test(m)) continue;
      modeles.push(m);
    } else if (estMarqueurVariante(m)) {
      variantes.push(m);
    }
  }
  if (modeles.length === 0) return null;

  const marqueCle = marqueNormalisee(marque);
  /* Un « code fort » est un code modèle qui n'appartient qu'à un article :
     assez long, et mêlant lettres et chiffres — « wh1000xm5 », « u4025qw ». */
  const forts = modeles.filter((m) => m.length >= 5 && /[a-z]/.test(m) && /\d/.test(m));
  if (!marqueCle && forts.length === 0) return null;

  /* Quand un code fort existe, il SUFFIT — et les autres nombres du titre
     sont du bruit qu'il faut écarter. C'est ce qui séparait « Écran Dell
     U4025QW 40 pouces » de « Dell U4025QW moniteur incurvé » : la diagonale,
     citée par un marchand et pas par l'autre, ajoutait un jeton et cassait
     le rapprochement. Sans code fort, en revanche, ce sont justement les
     nombres qui distinguent — un iPhone 15 128 Go d'un 256 Go — et il faut
     tous les garder. */
  const retenus = forts.length > 0 ? forts : modeles;

  const jetons = [...new Set([...retenus, ...variantes])].sort();
  return `${marqueCle || "?"}|${jetons.join("|")}`.slice(0, 200);
}

/** Le titre le plus court l'emporte : c'est celui qui porte le moins de marketing. */
function titreCanonique(actuel, candidat) {
  if (!candidat) return actuel;
  if (!actuel) return candidat;
  return candidat.length < actuel.length ? candidat : actuel;
}

const SELECT_EAN = db.prepare("SELECT * FROM produits WHERE ean = ?");
const SELECT_REF = db.prepare("SELECT * FROM produits WHERE marque = ? AND reference = ?");
const SELECT_EMPREINTE = db.prepare("SELECT * FROM produits WHERE empreinte = ? ORDER BY id LIMIT 1");
const SELECT_TITRE = db.prepare("SELECT * FROM produits WHERE cle_titre = ? AND empreinte IS NULL ORDER BY id LIMIT 1");
const INSERT = db.prepare(`
  INSERT INTO produits (ean, marque, reference, empreinte, cle_titre, titre, categorie)
  VALUES (@ean, @marque, @reference, @empreinte, @cle_titre, @titre, @categorie)
`);

/**
 * L'identifiant du produit décrit par une observation, créé si besoin.
 *
 * Enrichit au passage : un produit découvert par son empreinte et revu plus
 * tard avec son code-barres se voit attribuer ce code-barres, et devient donc
 * rapprochable avec n'importe quel marchand qui le publie. C'est ainsi que la
 * couverture se construit — pas d'un coup, mais à chaque relevé.
 */
function resoudre({ ean, marque, reference, nom, categorie = null } = {}) {
  const titre = String(nom || "").trim().slice(0, 200);
  if (!titre) return null;

  const e = eanNormalise(ean);
  const mq = marqueNormalisee(marque);
  const rf = referenceNormalisee(reference);
  const emp = empreinte(titre, marque);
  const cle = productKey(titre);

  const enrichir = (ligne) => {
    const maj = {};
    if (e && !ligne.ean) maj.ean = e;
    if (mq && !ligne.marque) maj.marque = mq;
    if (rf && !ligne.reference) maj.reference = rf;
    if (emp && !ligne.empreinte) maj.empreinte = emp;
    const t = titreCanonique(ligne.titre, titre);
    if (t !== ligne.titre) maj.titre = t;
    if (categorie && !ligne.categorie) maj.categorie = categorie;

    const champs = Object.keys(maj);
    if (champs.length > 0) {
      try {
        db.prepare(
          `UPDATE produits SET ${champs.map((c) => `${c} = ?`).join(", ")}, maj_le = datetime('now') WHERE id = ?`
        ).run(...champs.map((c) => maj[c]), ligne.id);
      } catch {
        /* Une contrainte d'unicité veut dire qu'un AUTRE produit porte déjà
           cet EAN ou cette référence. Deux lignes désignent alors le même
           article — la fusion est un travail à part, et surtout pas un effet
           de bord silencieux au milieu d'un scan. On garde l'identité déjà
           attribuée : le pire qui arrive est un rapprochement manqué. */
      }
    }
    return ligne.id;
  };

  // 1. Le code-barres. Rien ne le dépasse.
  if (e) {
    const parEan = SELECT_EAN.get(e);
    if (parEan) return enrichir(parEan);
  }

  // 2. Marque + référence fabricant.
  if (mq && rf) {
    const parRef = SELECT_REF.get(mq, rf);
    if (parRef) return enrichir(parRef);
  }

  // 3. L'empreinte modèle. On n'adopte une ligne trouvée ainsi que si elle
  //    ne porte pas DÉJÀ un autre code-barres : même empreinte et EAN
  //    différents veut dire deux articles voisins, pas un seul.
  if (emp) {
    const parEmp = SELECT_EMPREINTE.get(emp);
    if (parEmp && !(e && parEmp.ean && parEmp.ean !== e)) return enrichir(parEmp);
  }

  /* 4. À défaut, l'identité par le titre — le comportement d'avant, qui garde
        au produit son propre historique chez son propre marchand.

        Interdit dès qu'un code-barres est présent : deux EAN différents sont
        deux articles différents, même sous un titre identique. Deux manettes
        Xbox de coloris distincts se nomment exactement pareil chez le même
        marchand ; les confondre ferait dire que l'une brade l'autre. */
  if (!emp && !e) {
    const parTitre = SELECT_TITRE.get(cle);
    if (parTitre) return enrichir(parTitre);
  }

  const info = INSERT.run({
    ean: e,
    marque: mq,
    reference: rf,
    empreinte: emp,
    cle_titre: cle,
    titre,
    categorie,
  });
  return Number(info.lastInsertRowid);
}

/** Un produit par son identifiant. */
function produit(id) {
  return db.prepare("SELECT * FROM produits WHERE id = ?").get(id) || null;
}

/**
 * Le dernier prix connu de chaque marchand qui vend ce produit.
 *
 * La requête vit ici et non dans le routeur : une route qui écrit du SQL fait
 * dépendre la couche HTTP du schéma, et le jour où `snapshots` change c'est
 * le routeur qu'il faut relire.
 */
function offresDuProduit(id) {
  return db
    .prepare(
      `SELECT s.seller, s.price, s.url, s.img, s.name, s.item_condition, s.scraped_at
         FROM snapshots s
         JOIN (SELECT seller, MAX(scraped_at) AS dernier FROM snapshots
                WHERE produit_id = ? AND price > 0 AND seller IS NOT NULL
                GROUP BY seller) d
           ON d.seller = s.seller AND d.dernier = s.scraped_at
        WHERE s.produit_id = ? AND s.price > 0
        ORDER BY s.price ASC`
    )
    .all(id, id);
}

/**
 * Sur quoi repose l'identité de ce produit.
 *
 * Le visiteur a le droit de savoir : « même code-barres » et « titres qui se
 * ressemblent » ne se valent pas, et présenter les deux de la même façon
 * serait vendre une certitude qu'on n'a pas.
 */
function forceIdentite(p) {
  if (!p) return null;
  if (p.ean) return "ean";
  if (p.marque && p.reference) return "reference";
  if (p.empreinte) return "empreinte";
  return "titre";
}

/** Le produit, ses marchands et ce que vaut leur rapprochement. */
function vueProduit(id) {
  const p = produit(id);
  if (!p) return null;
  const offres = offresDuProduit(id);
  return {
    id: p.id,
    titre: p.titre,
    ean: p.ean,
    marque: p.marque,
    reference: p.reference,
    categorie: p.categorie,
    identite: forceIdentite(p),
    marchands: offres.map((o) => ({
      marchand: o.seller,
      prix: o.price,
      url: o.url,
      img: o.img,
      titre: o.name,
      etat: o.item_condition || "neuf",
      releveLe: o.scraped_at,
    })),
    meilleurPrix: offres.length ? offres[0].price : null,
    nbMarchands: new Set(offres.map((o) => o.seller)).size,
  };
}

/** Combien de produits, et combien portent une identité forte. */
function couverture() {
  return db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(ean IS NOT NULL) AS avec_ean,
              SUM(reference IS NOT NULL AND marque IS NOT NULL) AS avec_reference,
              SUM(empreinte IS NOT NULL) AS avec_empreinte
         FROM produits`
    )
    .get();
}

module.exports = {
  resoudre,
  vueProduit,
  offresDuProduit,
  forceIdentite,
  produit,
  couverture,
  empreinte,
  eanNormalise,
  marqueNormalisee,
  referenceNormalisee,
};
