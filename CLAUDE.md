# RadarPrix — Contexte du dépôt (pour Claude)

## Vue d'ensemble

Backend Node.js / Express 5 d'un site français de bons plans (radarprix.fr).
Base **SQLite locale** (`better-sqlite3`), authentification **JWT + bcrypt**,
déployé sur Railway (le frontend, lui, est sur Vercel et n'est PAS dans ce
dépôt). L'API ne parle qu'en JSON.

Point d'entrée : `npm start` → `src/server.js` (port `PORT` ou 3001).

## Stack

- Node.js ≥ 18 (CommonJS côté serveur, ESM côté tests Vitest)
- express 5, helmet, cors, dotenv (via `src/env.js`)
- better-sqlite3 (synchrone, une seule connexion partagée `db` exportée par `src/db.js`)
- bcryptjs, jsonwebtoken
- rss-parser + fast-xml-parser (flux RSS/feeds marchands)
- Firecrawl (scraping SaaS, via REST `fetch`, pas de SDK)
- vitest + eslint (config dans `eslint.config.mjs`)

## Architecture (src/)

| Fichier | Rôle |
|---|---|
| `server.js` | Routeur Express : toutes les routes API, middlewares (helmet, CORS, rate limiting), arrêt propre SIGTERM |
| `db.js` (~2000 l.) | Connexion SQLite, schéma, migrations `ALTER TABLE`, fonctions d'accès (comptes, watchlist, modération, admin, suivi des scans `debuterScan`/`terminerScan`/`logSourceEvent`/`sourceHealth`, réglages `reglages()`/`definirReglage`, liste noire `offreBannie`) |
| `collect.js` | **Moteur d'acquisition neuf** : table `watch_targets`, CRUD, collecteurs (flux + Firecrawl), pipeline `lancerScan` |
| `scan.js` | CLI : `npm run scan` — un scan complet synchrone (usage cron) |
| `algorithm.js` | Analyse des prix : référence entre pairs + historique, verdicts `erreur`/`deal`, scores Deal/Confidence |
| `dealsStore.js` | Table unifiée `deals` (détecteurs D1–D4), ingestion idempotente `UNIQUE(source, external_id)`, flux public paginé |
| `productKey.js` | Normalisation de titres produits (clé d'identité pour l'historique) |
| `marchands.js` | Registre de 122 enseignes et marques françaises : reconnaissance d'un vendeur par domaine ou par son nom dans un texte, et construction du lien de sortie vers le marchand |
| `categories.js` | Rubriques des sources ramenées aux catégories RadarPrix |
| `extraction.js` | Lecture d'une fiche produit telle que le marchand la publie : JSON-LD schema.org, microdata, OpenGraph |
| `pepper.js` | Lecture des sites de bons plans bâtis sur Pepper (Dealabs, Mydealz…) |
| `catalogue.js` | Suivi du catalogue d'un marchand par son propre sitemap : découverte, échantillon stable, rotation des relevés |
| `awin.js` | Catalogues produits des marchands via le réseau d'affiliation — la voie vers l'indépendance |
| `auth.js`, `moderation.js`, `messagerie.js`, `forum.js`, `notifications.js`, `badges.js`, `ranking.js`, `reputation.js`, `persistance.js`, `radarEtat.js`, `reinitialisation.js`, `env.js` | Comptes/sécurité, validation/anti-spam, salon + MP, forum, notifications, badges, score hot, fiabilité marchands, sauvegarde/restauration de la base, état public du radar, reset admin, chargement env |

## Moteur de détection (ce qui a été construit récemment)

L'ancienne machinerie (SerpApi, Bright Data, eBay, Awin, sitemaps, cron maison)
a été **retirée** puis **remplacée** par une acquisition propre :

- **Cibles** (`watch_targets`) : un produit (`query`), une catégorie, un
  marchand, et de quoi aller le chercher — **`feed_url`** (flux RSS/Atom ou
  XML type Google Shopping, aucune clé) **ou** **`search_domains`** (JSON
  array de domaines marchands pour Firecrawl).
- **Pipeline** (`lancerScan`) par cible : collecte → `insertSnapshots` →
  `analyzeOffers` (algorithm.js) → publication des anomalies dans `deals`
  (détecteur `D3`, type `erreur` ou `promo`) via `upsertDeal` + `publierDeal`.
  Pour les flux, `markMissingAsRemoved` retire les offres disparues.
- **Firecrawl** (REST, pas de SDK) :
  - `POST /v2/search` (réponse : `data.web[]` — ne PAS lire `data` directement)
  - `POST /v2/scrape` (`formats: ["markdown"]`) — prix pris dans
    `data.product.variants[].price.amount` si présent, sinon regex sur le
    markdown (heuristique, imparfaite).
  - Clé : `FIRECRAWL_API_KEY` (côté serveur uniquement).
- **Routes admin** (server.js) : `GET/POST/PATCH/DELETE /api/admin/targets`,
  `POST /api/admin/scan` (jeton admin **ou** en-tête `x-scan-token` si
  `SCAN_TOKEN` défini — comparaison en temps constant), `GET /api/admin/scan/status`.
- **État public** : `radarEtat.js` lit `watch_targets` + `scan_runs`
  (plus les anciennes tables de surveillance).
- Un seul scan à la fois (garde `scanEnCours`), échec d'une cible ≠ échec du
  scan (journalisé dans `source_events`, source `flux` ou `firecrawl`).

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `JWT_SECRET` | **Obligatoire.** Signe les sessions (30 j). |
| `DB_PATH` | Chemin SQLite. Prod : volume persistant. |
| `PORT` | Port d'écoute. |
| `ADMIN_EMAIL` | Email promu admin à l'inscription. |
| `CORS_ORIGINS` | Origines autorisées (remplace la liste par défaut). |
| `FIRECRAWL_API_KEY` | Clé du scraping SaaS (sans elle, seules les cibles à flux marchent). |
| `SCAN_TOKEN` | Jeton cron pour `POST /api/admin/scan` (en-tête `x-scan-token`). |

`src/env.js` charge `.env` puis `.env.local` (le sandbox Freebuff écrit ses
secrets dans `.env.local`, jamais commité — voir `.gitignore`). dotenv ne
remplace jamais une variable déjà présente dans l'environnement réel.

## Conventions

- **CommonJS** pour `src/` (require/module.exports), **ESM** pour `tests/`
  (import + `createRequire` pour charger les modules CJS).
- Commentaires **en français**, orientés « pourquoi » ; ne pas les supprimer.
- Chaque module de domaine crée ses **propres tables** (`dealsStore`,
  `notifications`, `collect`) avec `CREATE TABLE IF NOT EXISTS` sur la
  connexion partagée `db` — ne pas tout entasser dans `db.js`.
- Ingestion stricte : lever une erreur plutôt que stocker une ligne invalide.
- Sécurité : hachage bcrypt, propriété vérifiée dans les requêtes SQL,
  rate limiting en mémoire (par IP pour l'auth, par membre pour les
  publications), contrôle de suspension centralisé, clés API jamais côté client.
- `better-sqlite3` est synchrone : pas de `await` sur les requêtes DB.

## Tests

```bash
npm install
npm test        # vitest — 146 tests (tests/*.test.js, base SQLite temporaire isolée par fichier)
npm run lint    # eslint
npm run scan    # un scan complet de toutes les cibles actives (cron)
```

Les seize scripts `test-*.js` de la racine ont été supprimés : aucun n'était
lancé par `npm test`, ils ne servaient qu'à être lus.

## Ce que la collecte peut et ne peut pas

Mesuré, pas supposé, le 22 août 2026 :

- **Scraper les marchands en direct ne marche pas.** Douze fiches produits
  sondées chez les grandes enseignes françaises : **une seule** répond en
  HTTP direct. Les autres rendent 403 (Cloudflare, DataDome) ou chargent
  tout en JavaScript. Vingt-huit pages « promotions » sondées : **zéro
  produit extrait**. Les chemins devinés ont été retirés du registre.
- **Les agrégateurs marchent, mais ce ne sont pas nos données.** Une page
  Dealabs rend cinquante offres avec prix de référence, marchand, image et
  date de fin. C'est ce qui remplit le site aujourd'hui — un dépannage, pas
  une fondation.
- **Cinq marchands se laissent parcourir par leur propre sitemap**, et
  balisent leurs fiches en schema.org. Mesuré sur les 84 enseignes du
  registre : LDLC (78 667 fiches, 6/6 lues), JouéClub (40 001, 4/4), Ikea
  (4 526, 4/4), Electro Dépôt (2 915, 4/4), Nature & Découvertes (107,
  4/4). C'est `catalogue.js`, et c'est **le seul canal dont les anomalies
  sont les nôtres** : on relève des prix ordinaires, encore et encore, et
  `algorithm.js` dit lequel a décroché.
- **Le réseau d'affiliation reste la voie la plus riche** (`awin.js`) :
  catalogue complet avec description, EAN et prix conseillé, et un lien
  qui mène chez le marchand. Il faut `AWIN_PUBLISHER_ID`, `AWIN_API_TOKEN`
  et `AWIN_FEED_KEY`. Le diagnostic au démarrage dit ce qui manque.

## Arithmétique de la rotation

Un passage relève 60 fiches, le cron passe 8 fois par jour : 480 relevés
quotidiens par marchand. D'où le plafond de **800 fiches suivies** par
catalogue — on repasse sur chacune toutes les 40 heures, ce qu'il faut pour
voir un prix décrocher. Suivre les 78 667 fiches de LDLC ferait revenir sur
chacune tous les 164 jours, autant ne rien mesurer.

Ce réglage repère une baisse qui dure, **pas une erreur de prix de vingt
minutes**. Celle-là demanderait de surveiller quelques dizaines de produits
en permanence — même mécanisme, autre réglage, à ajouter quand on saura
quels produits surveiller.

## Règle de sortie

Une carte n'envoie **jamais** vers l'agrégateur qui nous a renseignés, quel
que soit le canal. Le lien est reconstruit vers le marchand (recherche
maison pour 37 enseignes, page d'accueil sinon) et l'offre n'est pas
publiée si aucun lien n'est constructible.

## Limites connues / pistes

- Extraction du prix depuis le markdown Firecrawl = heuristique (regex) : peut
  attraper un mauvais nombre sur une page complexe. Fiabiliser en passant par
  `data.product` structuré de Firecrawl, ou par un LLM.
- `better-sqlite3` bloque le thread principal : plafond de charge du site.
- Rate limiting en mémoire : ok mono-processus (Railway), à revoir si scale-out.
- Pas de réinitialisation de mot de passe ni de vérification d'email.
- Les alertes watchlist (`watchersFor`, `recordAlertSent`, `email_log`) sont
  en place mais aucun envoi d'email n'est branché actuellement.
