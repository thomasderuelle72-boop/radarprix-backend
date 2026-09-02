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
| `navigateur.js` | Client HTTP qui ressemble à un navigateur : jeu d'en-têtes complet, pot à cookies, pause par hôte, patience sur 429/503, **lecture bornée à 20 Mo** |
| `lecture.js` | Repli du balisage : lit le prix d'une fiche avec un modèle, sous schéma strict et sous budget. N'écrit jamais un prix absent de la page |
| `pepper.js` | Lecture des sites de bons plans bâtis sur Pepper (Dealabs, Mydealz…) |
| `catalogue.js` | Suivi du catalogue d'un marchand par son propre sitemap : découverte, échantillon stable, rotation des relevés |
| `awin.js` | Catalogues produits des marchands via le réseau d'affiliation — la voie vers l'indépendance |
| `identites.js` | Connexion Google et Apple : vérification du jeton d'identité (signature, émetteur, destinataire, expiration) et table `identites_externes` |
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
| `ANTHROPIC_API_KEY` | Lecture assistée par modèle (`lecture.js`). |
| `GEMINI_API_KEY` | Idem, côté Google. **Enveloppe gratuite** suffisante pour nos 40 fiches/scan. Sans l'une ni l'autre, le repli se tait. |
| `LECTURE_FOURNISSEUR` | `gemini` ou `anthropic`. Par défaut : Gemini si sa clé existe, sinon Anthropic. |
| `GOOGLE_CLIENT_ID` | Connexion Google. Gratuit (Google Cloud → Identifiants → ID client OAuth, type « Application Web »). Public par construction — le navigateur doit le présenter. |
| `APPLE_SERVICES_ID` | Connexion Apple. Exige un compte Apple Developer payant (99 $/an) et un **Services ID**, pas l'App ID — c'est la confusion la plus courante. |
| `LECTURE_MODELE` | Modèle de lecture. Défaut : `gemini-flash-lite-latest` ou `claude-opus-5` selon le fournisseur. Changer de gamme est un arbitrage de coût, donc une décision d'exploitant. |
| `LECTURE_PLAFOND` | Fiches lues par le modèle au plus, par scan (défaut 40). |
| `SCAN_TOKEN` | Jeton cron pour `POST /api/admin/scan` (en-tête `x-scan-token`). |
| `AWIN_PUBLISHER_ID`, `AWIN_API_TOKEN`, `AWIN_FEED_KEY` | Réseau d'affiliation. Les deux premières ouvrent l'API, la troisième les catalogues produits. |

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
- **Treize marchands se laissent parcourir par leur propre sitemap.**
  Mesuré le 24 août 2026 par `POST /api/admin/catalogues/sonde`, **depuis
  l'IP qui collecte** — précision qui n'est pas un détail : le relevé
  précédent n'en trouvait que cinq, et il avait été fait ailleurs. Trois
  fiches sondées par marchand :

  | 3/3 | partiels | anciens |
  |---|---|---|
  | Boulanger, E.Leclerc, Rue du Commerce, Brico Dépôt, Truffaut | Bouygues Telecom (2/3), Roady (2/3), Recommerce (1/3), SFR (1/3) | LDLC, JouéClub, Electro Dépôt, Nature & Découvertes |

  Boulanger et E.Leclerc ne sont pas des marchands de niche. C'est
  `catalogue.js`, et c'est **le seul canal dont les anomalies sont les
  nôtres** : on relève des prix ordinaires, encore et encore, et
  `algorithm.js` dit lequel a décroché.

- **Onze marchands se laissent atteindre mais pas lire** : Aldi, Free,
  Ikea, Leroy Merlin, Kiabi, Vinted, Marionnaud, Nocibé, Momox, Feu Vert,
  Midas listent leurs fiches et servent leurs pages, mais `extraction.js`
  n'y trouve aucun prix — ni schema.org, ni microdata, ni OpenGraph
  exploitable. Ceux-là ne demandent aucun proxy : ils demandent une
  meilleure lecture. C'est la cible naturelle d'une extraction assistée par
  modèle, en repli du balisage.

- **Une trentaine refusent robots.txt en 403** — Decathlon, Cultura,
  Sarenza, Norauto, Oscaro, Conforama, Maisons du Monde, La Redoute,
  Rakuten… Là, ce n'est pas notre code qui est en cause mais notre IP, et
  aucune ligne n'y changera rien.
- **Le réseau d'affiliation reste la voie la plus riche** (`awin.js` +
  `collecterAwin` dans `collect.js`) : catalogue complet avec description,
  EAN et prix conseillé, et un lien qui mène **vraiment** sur la fiche du
  marchand — ce qu'aucun autre canal ne donne quand l'offre vient d'un
  agrégateur. Deux conditions :
  `AWIN_PUBLISHER_ID` + `AWIN_API_TOKEN` (le compte répond) et
  `AWIN_FEED_KEY` (distincte du jeton — Awin → Toolbox → Create-a-Feed).
  Le diagnostic au démarrage nomme celle qui manque.

  **Rejoindre un programme n'est PAS nécessaire pour lire son catalogue.**
  On l'avait cru et écrit ici ; la liste des flux dit le contraire, mesuré
  le 24 août 2026 : 583 catalogues répondent à notre clé, tous en
  « Not Joined ». Ce que l'adhésion apporte est la rémunération, pas
  l'accès aux données. Sur ces 583, **dix-huit** portent une région ou une
  langue française (`GB 195, US 141, DE 60, PL 39, NL 34, ES 20, FR 18…`),
  et aucun n'est une enseigne du registre : parfumerie, luminaire,
  claviers, soin capillaire. `fluxFrancais()` les trie par nombre de
  références ; `CATALOGUES_AWIN` (collect.js) en sème dix.

  Une cible Awin porte ses identifiants de flux dans `awin_feeds`
  (« 12345,67890 »). L'échantillon se prend **sur les lignes du CSV**, avant
  de construire le moindre objet : un catalogue de plusieurs centaines de
  milliers de références converti en entier ferait passer le processus qui
  sert le site de quelques mégaoctets à plus d'un gigaoctet.

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

Chaque offre porte désormais un **`lienType`** qui dit où son lien mène —
`produit` (la fiche), `recherche` (une recherche chez le marchand),
`marchand` (sa page d'accueil), ou rien. Il est posé par le collecteur, qui
est le seul à savoir :

| Canal | `lienType` | Pourquoi |
|---|---|---|
| `awin.js` (catalogue) | `produit` | `aw_deep_link` ouvre la fiche |
| `collecterCatalogue` | `produit` | on vient de lire cette fiche |
| `collecterFirecrawl` | `produit` | recherche bornée aux domaines marchands |
| `collecterFlux` | `produit` **sauf** si l'hôte est un agrégateur | un flux marchand mène au produit, un fil Pepper à lui-même |
| `collecterPagePromo` | `produit` si le balisage donne le lien, sinon `marchand` | à défaut on retombe sur le rayon |
| Pepper / Awin non rejoint | `recherche` ou `marchand` | le lien est reconstruit, pas connu |

Mesuré le 25 août 2026 : **zéro** des 105 offres en ligne portait
`produit`, alors que les catalogues Awin en fournissaient de vrais. L'étiquette
n'était simplement jamais posée. Le réglage **`lienProduitExige`** (défaut
**1**) refuse de publier ce qui n'ouvre pas la fiche : c'est un arbitrage
entre remplir le site et le rendre utile, et il coûte aujourd'hui toutes les
offres venues de Dealabs — qui n'expose jamais l'adresse du marchand
(`link` vide, seulement `linkHost` et une redirection d'affiliation
`/visit/thread/<id>` qu'on ne détourne pas).

## Zéro n'est pas un prix

Le 2 septembre 2026, les **51 offres publiées** étaient toutes à **0,00 €**,
toutes verdict « erreur », toutes à **−100 %** : pelotes de laine, soutien-gorge,
combo guitare basse à la place de 777 €. La cause tient en un mot :

```js
Number.isFinite(0) === true
```

Huit gardes de prix dans `src/`, **une seule** testait aussi `> 0`. Un marchand
écrit `"price": "0"` sur une fiche en rupture ou réservée à un vendeur tiers
absent ; l'extraction le lisait, `insertSnapshots` l'enregistrait sans rien
valider, et `analyzeOffers` en concluait — correctement — `pct = 100`, donc
`>= seuilErreur`, donc la une. L'algorithme n'a jamais eu tort : on lui
donnait zéro euro.

Le correctif est un prédicat unique, `prixValide()` (`extraction.js`), appliqué
à cinq niveaux, parce qu'un seul aurait re-cassé au prochain collecteur :

1. **extraction** — les quatre stratégies (JSON-LD, microdata, OpenGraph,
   AggregateOffer) rendent `null` plutôt qu'un prix nul ;
2. **collecte** — flux RSS, flux XML, Firecrawl, catalogue ; et une fiche que
   le marchand déclare épuisée (`disponible === false`) n'est plus relevée,
   champ qui était extrait depuis toujours et que seul Awin lisait ;
3. **ingestion** — `insertSnapshots` **lève**, comme le veut la convention du
   dépôt. Le contrôle passe avant la transaction : un lot est accepté en
   entier ou refusé en entier. `lancerScan` absorbe déjà l'échec d'une cible ;
4. **algorithme** — `analyzeOffers` refuse de *juger* ce qui n'est pas un
   prix, et écarte les relevés à zéro **déjà en base** du calcul de référence.
   `stripGrossOutliers` ne les retirait pas : sur une fiche en rupture depuis
   plusieurs jours ils sont **majoritaires**, et la référence tombait à zéro ;
5. **flux public** — `listDeals` masque `price <= 0`, sauf le type
   `gratuit` où zéro est le sujet de l'offre (un jeu Epic coûte bien 0 €),
   et tolère `price IS NULL` (un code promo n'annonce pas toujours un montant).

`purgerPrixInvalides()` tourne au démarrage : retire les offres publiées à
prix nul et **supprime** les relevés correspondants — une référence bâtie sur
des zéros fabrique des remises imaginaires longtemps après le correctif.

Corrigé au passage : `allTimeLow` faisait `Math.min(...lignes)` sur un
tableau que `priceHistoryBatch` ne borne pas (60 jours, aucun `LIMIT`) —
une réduction ne dépend pas de la taille de la pile.

**Ce bug était masqué.** Tant que le site publiait 105 cartes venues de
Dealabs, les 51 offres à zéro se noyaient dedans. `lienProduitExige` les a
mises au premier plan en retirant tout le reste.

## Ce que la détection ne fait PAS (constaté le 2 septembre 2026)

- **`filterRelevantOffers` n'est appelé nulle part.** Il est exporté, testé,
  et mort. Donc `isAccessoryTitle` ne filtre rien en production. C'est
  défendable sur un catalogue marchand — une coque de téléphone est un
  produit que l'enseigne vend, et son prix cassé est un vrai deal — mais
  c'est un choix qui n'a jamais été écrit.
- **La référence entre pairs est structurellement impossible sur le canal
  catalogue.** `lancerScan` appelle `analyzeOffers` **par cible** : 60 fiches
  d'un seul marchand, toutes des produits différents. `clusterByProduct`
  rend 60 groupes de un, `comparables.length < minPairs` (2), donc
  `peerRefByOffer` reste vide. Sur le seul canal dont les anomalies sont les
  nôtres, la détection repose à 100 % sur le passé de la même enseigne —
  d'où `baseReference: "marchand"` sur 31 des 51 offres mesurées.
- **Le rapprochement entre marchands ne fonctionne pas** : 5 produits vus
  chez ≥ 2 marchands sur 8 591 (0,06 %), et **50 relevés portant un EAN sur
  23 152** (0,2 %), dont **aucun** partagé. `productKey` exige le même
  ensemble exact de mots significatifs : deux enseignes ne titrent jamais
  pareil.
- **`clusterByProduct` est glouton et dépendant de l'ordre** : il ne compare
  qu'au **premier** élément de chaque groupe, sur une relation non
  transitive. Deux ordres d'entrée donnent deux regroupements. O(n²) avec
  re-tokenisation à chaque comparaison.

## Limites connues / pistes

- Extraction du prix depuis le markdown Firecrawl = heuristique (regex) : peut
  attraper un mauvais nombre sur une page complexe. Fiabiliser en passant par
  `data.product` structuré de Firecrawl, ou par un LLM.
- `lecture.js` accepte **deux fournisseurs** (Anthropic, Gemini) mais un
  seul filet de sécurité : ce qui change est l'appel, ce qui ne change
  jamais est la vérification qui suit. Un fournisseur n'est pas cru sur
  parole. Le schéma de Gemini s'écrit dans son propre dialecte (`nullable:
  true`, pas `type: ["number","null"]`) — traduire à la volée serait une
  source d'erreur silencieuse.
- Le disjoncteur distingue le **définitif** (crédit, quota, clé refusée :
  on coupe tout de suite, réessayer répéterait la même réponse) du
  **passager** (délai dépassé, 5xx : trois échecs consécutifs tolérés). La
  première version coupait au premier ennui venu, et un seul délai dépassé
  suffisait à priver le scan entier de lecture.
- Le budget se décompte au moment où un appel **part vraiment**, pas à
  l'entrée : quarante pages trop courtes pour valoir un appel épuisaient le
  plafond sans qu'un mot ait été envoyé.
- `lecture.js` ne se déclenche **qu'en repli** de `extraction.js`, et refuse
  tout prix qui ne se retrouve pas tel quel dans le texte de la page. C'est
  le garde-fou central : un prix inventé mais plausible est pire qu'une
  absence de prix — il devient une référence, puis une remise, puis une
  carte qui ment. Le cache de préfixe n'est pas branché, et volontairement :
  il demande mille tokens stables en tête de requête, la consigne est bien
  plus courte, l'activer ne ferait rien en silence.
- `better-sqlite3` bloque le thread principal : plafond de charge du site.
- Rate limiting en mémoire : ok mono-processus (Railway), à revoir si scale-out.
- Pas de réinitialisation de mot de passe ni de vérification d'email.
- Connexion externe : on n'accepte le **rattachement par email** que si le
  fournisseur déclare l'adresse vérifiée (`email_verified`). Sans ce
  contrôle, déclarer l'adresse de quelqu'un d'autre suffirait à réclamer son
  compte — c'est la faille classique de ce mécanisme. Le rattachement
  primaire se fait toujours sur le `sub` du fournisseur, stable même si la
  personne change d'adresse. Aucun « client secret » n'est utilisé : le flux
  repose sur le seul jeton d'identité, vérifié contre les clés publiques du
  fournisseur.
- Les alertes watchlist (`watchersFor`, `recordAlertSent`, `email_log`) sont
  en place mais aucun envoi d'email n'est branché actuellement.
