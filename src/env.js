// env.js — Chargement des variables d'environnement locales.
//
// dotenv ne lit que `.env`. Or le sandbox Freebuff écrit ses secrets dans
// `.env.local` (via freebuff-env), et les deux fichiers coexistent. On
// charge donc les deux, dans cet ordre :
//
//   environnement réel (injecté par l'hébergeur)
//     > .env          (valeurs partagées du dépôt)
//     > .env.local    (secrets locaux, jamais commités)
//
// dotenv ne remplace jamais une variable déjà présente dans
// process.env : un secret injecté par l'hébergeur garde toujours la
// priorité, et un .env.local absent ne change rien.
require("dotenv").config();

const fs = require("fs");
const path = require("path");

const local = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(local)) {
  require("dotenv").config({ path: local });
}
