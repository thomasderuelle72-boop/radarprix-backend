// identites.js — Connexion par Google et par Apple.
//
// COMMENT ÇA MARCHE, ET POURQUOI AINSI
//
// Le navigateur obtient du fournisseur un « jeton d'identité » : un JWT signé
// par Google ou par Apple qui affirme « la personne devant moi est bien
// celle-ci ». Il nous l'envoie, on le vérifie, et on ouvre une session
// RadarPrix ordinaire. On ne voit jamais le mot de passe du compte Google,
// on ne stocke aucun jeton du fournisseur, et on ne demande aucun accès à
// ses données.
//
// LA VÉRIFICATION EST TOUT
//
// Un jeton d'identité n'est qu'un texte : accepté sans contrôle, il laisse
// entrer n'importe qui sous n'importe quelle identité. Quatre contrôles, et
// aucun n'est facultatif :
//
//   1. La SIGNATURE, contre la clé publique du fournisseur, elle-même
//      récupérée à son adresse officielle. Sans elle, un jeton se fabrique
//      au clavier.
//   2. L'ÉMETTEUR (`iss`) : il doit être Google ou Apple, pas un tiers.
//   3. LE DESTINATAIRE (`aud`) : il doit être NOTRE identifiant client. Sans
//      ce contrôle, un jeton émis pour un autre site — que son exploitant
//      peut lire — ouvrirait une session chez nous.
//   4. L'EXPIRATION, que `jsonwebtoken` vérifie de lui-même.
//
// AUCUNE DÉPENDANCE NOUVELLE
//
// `jsonwebtoken` est déjà là, et Node sait transformer une clé au format JWK
// en clé publique depuis la version 16. Une bibliothèque de plus pour ça
// serait une surface d'attaque de plus.

const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { db } = require("./db");

/* Les deux fournisseurs, décrits par ce qui les distingue. Le reste du code
   ne sait pas lequel il traite — c'est ce qui permet d'en ajouter un
   troisième sans rien réécrire. */
const FOURNISSEURS = {
  google: {
    nom: "Google",
    cles: "https://www.googleapis.com/oauth2/v3/certs",
    // Google émet sous deux formes selon l'ancienneté du flux ; les deux
    // sont légitimes et documentées.
    emetteurs: ["https://accounts.google.com", "accounts.google.com"],
    clientId: () => process.env.GOOGLE_CLIENT_ID,
  },
  apple: {
    nom: "Apple",
    cles: "https://appleid.apple.com/auth/keys",
    emetteurs: ["https://appleid.apple.com"],
    // L'identifiant d'Apple est celui du « Services ID », pas celui de
    // l'application : c'est la confusion la plus courante côté configuration.
    clientId: () => process.env.APPLE_SERVICES_ID,
  },
};

const configure = (f) => Boolean(String((FOURNISSEURS[f]?.clientId() ?? "")).trim());

/** Les fournisseurs réellement utilisables, pour que le site n'affiche que ceux-là. */
const fournisseursActifs = () => Object.keys(FOURNISSEURS).filter(configure);

/* Les clés publiques changent : les fournisseurs en font tourner
   régulièrement. On les garde une heure, et on les rappelle immédiatement si
   un jeton cite une clé qu'on ne connaît pas — c'est exactement ce qui
   arrive au moment d'une rotation, et ne pas le gérer ferait échouer toutes
   les connexions pendant des heures. */
const cache = new Map();
const DUREE_CACHE = 3600000;

async function clesDe(fournisseur, forcer = false) {
  const memo = cache.get(fournisseur);
  if (!forcer && memo && Date.now() - memo.a < DUREE_CACHE) return memo.cles;

  const rep = await fetch(FOURNISSEURS[fournisseur].cles, { signal: AbortSignal.timeout(10000) });
  if (!rep.ok) throw new Error(`clés ${FOURNISSEURS[fournisseur].nom} indisponibles (HTTP ${rep.status})`);
  const { keys } = await rep.json();
  if (!Array.isArray(keys) || !keys.length) throw new Error("jeu de clés vide");

  const cles = new Map();
  for (const jwk of keys) {
    try {
      cles.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" }));
    } catch {
      /* une clé illisible n'invalide pas les autres */
    }
  }
  cache.set(fournisseur, { a: Date.now(), cles });
  return cles;
}

/**
 * Vérifie un jeton d'identité et rend ce qu'il affirme.
 *
 * @returns {Promise<{sujet:string, email:string|null, emailVerifie:boolean, nom:string|null}>}
 * @throws si l'une des quatre vérifications échoue — et l'appelant ne doit
 *   JAMAIS rattraper cette erreur pour continuer quand même.
 */
async function verifierJeton(fournisseur, jeton) {
  const f = FOURNISSEURS[fournisseur];
  if (!f) throw new Error("fournisseur inconnu");
  const attendu = String(f.clientId() || "").trim();
  if (!attendu) throw new Error(`connexion ${f.nom} non configurée`);

  const entete = jwt.decode(jeton, { complete: true });
  if (!entete || !entete.header || !entete.header.kid) throw new Error("jeton illisible");

  let cles = await clesDe(fournisseur);
  if (!cles.has(entete.header.kid)) cles = await clesDe(fournisseur, true);
  const cle = cles.get(entete.header.kid);
  if (!cle) throw new Error("clé de signature inconnue");

  const charge = jwt.verify(jeton, cle, {
    algorithms: ["RS256"],
    issuer: f.emetteurs,
    audience: attendu,
  });

  if (!charge.sub) throw new Error("jeton sans identifiant de compte");

  /* `email_verified` arrive tantôt en booléen, tantôt en chaîne « true » —
     Apple utilise la seconde forme. Comparer sans normaliser reviendrait à
     traiter tous les comptes Apple comme non vérifiés. */
  const verifie = charge.email_verified === true || charge.email_verified === "true";

  return {
    sujet: String(charge.sub),
    email: charge.email ? String(charge.email).toLowerCase().trim() : null,
    emailVerifie: verifie,
    nom: charge.name ? String(charge.name).slice(0, 60) : null,
  };
}

/* Une table à part plutôt que deux colonnes dans `users` : un membre peut
   lier Google ET Apple ET garder son mot de passe, et un troisième
   fournisseur n'imposera pas de migration. */
db.exec(`
  CREATE TABLE IF NOT EXISTS identites_externes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fournisseur TEXT NOT NULL,
    sujet TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT,
    creee_le TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(fournisseur, sujet)
  );
  CREATE INDEX IF NOT EXISTS idx_identites_user ON identites_externes(user_id);
`);

const identiteDe = (fournisseur, sujet) =>
  db
    .prepare("SELECT * FROM identites_externes WHERE fournisseur = ? AND sujet = ?")
    .get(fournisseur, String(sujet));

const lier = (fournisseur, sujet, userId, email) =>
  db
    .prepare(
      `INSERT INTO identites_externes (fournisseur, sujet, user_id, email) VALUES (?, ?, ?, ?)
       ON CONFLICT(fournisseur, sujet) DO UPDATE SET user_id = excluded.user_id, email = excluded.email`
    )
    .run(fournisseur, String(sujet), userId, email || null);

/** Les fournisseurs liés à un compte — pour que le membre sache ce qui ouvre sa porte. */
const identitesDuMembre = (userId) =>
  db
    .prepare("SELECT fournisseur, email, creee_le FROM identites_externes WHERE user_id = ? ORDER BY id")
    .all(userId);

/** Délie un fournisseur. Rendu par l'appelant, qui doit d'abord vérifier
    qu'il reste un moyen de se connecter — sinon on enferme le membre dehors. */
const delier = (fournisseur, userId) =>
  db
    .prepare("DELETE FROM identites_externes WHERE fournisseur = ? AND user_id = ?")
    .run(fournisseur, userId).changes > 0;

module.exports = {
  FOURNISSEURS,
  configure,
  fournisseursActifs,
  verifierJeton,
  identiteDe,
  lier,
  identitesDuMembre,
  delier,
};
