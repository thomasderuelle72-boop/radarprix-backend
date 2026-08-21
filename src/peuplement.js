// peuplement.js — Remplir le radar sans intervention humaine.
//
// Enchaîne la découverte (decouverte.js, qui lit les sitemaps des marchands)
// et la surveillance (watch.js, qui relit les fiches et compare les prix).
// C'est ce qui transforme un moteur vide en site qui affiche des produits :
// aucune clé d'API, aucune adresse à saisir, aucun programme d'affiliation à
// attendre.
//
// Le rythme est volontairement modeste. Un sitemap de grande enseigne
// contient des centaines de milliers de fiches ; les avaler d'un coup
// saturerait la base, ferait exploser la facture du récupérateur de secours
// et ressemblerait à une attaque vue du marchand. On prend donc un petit lot
// par enseigne à chaque passage, en tournant.
const { decouvrirFiches } = require("./decouverte");
const { ajouterUrl, listerUrls } = require("./watch");
const { logSourceEvent } = require("./db");

/* Enseignes explorées, avec la catégorie dominante de leur catalogue — elle
   sert de rattachement par défaut tant que la fiche n'a pas été lue.
   ENSEIGNES_A_EXPLORER (variable d'environnement, "domaine:categorie"
   séparés par des virgules) remplace entièrement cette liste. */
const ENSEIGNES_DEFAUT = [
  { domaine: "www.cdiscount.com", nom: "Cdiscount", categorie: "hightech" },
  { domaine: "www.fnac.com", nom: "Fnac", categorie: "hightech" },
  { domaine: "www.darty.com", nom: "Darty", categorie: "maison" },
  { domaine: "www.boulanger.com", nom: "Boulanger", categorie: "maison" },
  { domaine: "www.ldlc.com", nom: "LDLC", categorie: "hightech" },
  { domaine: "www.decathlon.fr", nom: "Decathlon", categorie: "sport" },
  { domaine: "www.leroymerlin.fr", nom: "Leroy Merlin", categorie: "maison" },
  { domaine: "www.sephora.fr", nom: "Sephora", categorie: "beaute" },
];

function enseignes() {
  const configurees = (process.env.ENSEIGNES_A_EXPLORER || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const [domaine, categorie] = e.split(":");
      return {
        domaine: domaine.trim(),
        nom: domaine.replace(/^www\./, "").split(".")[0],
        categorie: (categorie || "tout").trim(),
      };
    });
  return configurees.length > 0 ? configurees : ENSEIGNES_DEFAUT;
}

// Position dans la rotation. En mémoire : au redémarrage on repart de la
// première enseigne, ce qui est sans conséquence — les fiches déjà connues
// ne sont pas réajoutées.
let curseur = 0;

/**
 * Découvre et met sous surveillance un lot de fiches.
 *
 * @param {object} [opts]
 * @param {number} [opts.enseignesParPassage] enseignes explorées à ce tour
 * @param {number} [opts.fichesParEnseigne]   fiches retenues par enseigne
 * @param {number} [opts.plafondTotal]        au-delà, on cesse d'ajouter
 * @returns {Promise<Array>} un résumé par enseigne
 */
async function peupler({
  enseignesParPassage = 2,
  fichesParEnseigne = 25,
  plafondTotal = 400,
  fetcher = fetch,
} = {}) {
  const connues = new Set(listerUrls({ limit: 10000, actives: false }).map((u) => u.url));
  const dejaSurveillees = connues.size;
  if (dejaSurveillees >= plafondTotal) {
    // Le plafond protège la facture autant que la politesse : chaque fiche
    // surveillée est relue toutes les quinze minutes, indéfiniment.
    return [{ ignore: true, motif: `plafond atteint (${dejaSurveillees}/${plafondTotal} fiches)` }];
  }

  const liste = enseignes();
  const resultats = [];

  for (let i = 0; i < Math.min(enseignesParPassage, liste.length); i++) {
    const enseigne = liste[curseur % liste.length];
    curseur++;

    try {
      const { urls, sitemapsLus, erreurs, echantillonVu } = await decouvrirFiches(enseigne.domaine, {
        limite: fichesParEnseigne,
        fetcher,
      });

      // On ne compte que les fiches réellement nouvelles : l'ajout est un
      // upsert, et compter les réécritures annoncerait « 25 fiches ajoutées »
      // à chaque passage sur un catalogue qui n'a pas bougé.
      let ajoutees = 0;
      let dejaConnues = 0;
      for (const url of urls) {
        if (connues.has(url)) {
          dejaConnues++;
          continue;
        }
        try {
          ajouterUrl({ url, merchant: enseigne.nom, category: enseigne.categorie });
          connues.add(url);
          ajoutees++;
        } catch {
          // URL rejetée par la validation : on continue le lot.
        }
      }

      logSourceEvent("decouverte", true, `${enseigne.nom} : ${ajoutees} nouvelle(s) sur ${urls.length} trouvée(s)`);
      resultats.push({
        enseigne: enseigne.nom,
        ok: true,
        trouvees: urls.length,
        ajoutees,
        dejaConnues,
        sitemapsLus,
        erreurs: erreurs.slice(0, 2),
        echantillonVu,
      });
    } catch (e) {
      logSourceEvent("decouverte", false, `${enseigne.nom} : ${e.message}`);
      resultats.push({ enseigne: enseigne.nom, ok: false, erreur: e.message });
    }
  }

  return resultats;
}

module.exports = { peupler, enseignes, ENSEIGNES_DEFAUT };
