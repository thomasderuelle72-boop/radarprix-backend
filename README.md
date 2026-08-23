# RadarPrix — Backend

API du site : comptes, profils, forum, salon, messagerie privée, notifications,
deals publiés par les membres, modération. Base SQLite locale, persistée sur un
disque monté par l'hébergeur.

> **L'ancienne machinerie de détection a été retirée** (ni SerpApi, ni Bright
> Data, ni eBay, ni Awin, ni sitemaps, ni cron maison) et **remplacée par un
> moteur neuf** : acquisition via flux RSS/feeds marchands et scraping SaaS
> (Firecrawl), analyse par `algorithm.js`, publication dans le flux unifié
> (`deals`, détecteur D3). Voir « Détection » plus bas.

## Ce qui tourne aujourd'hui

| Domaine | Modules |
| --- | --- |
| Comptes et sécurité | `auth.js`, `moderation.js` |
| Communauté | `forum.js`, `messagerie.js`, `notifications.js`, `badges.js`, `ranking.js`, `reputation.js` |
| Données | `db.js`, `dealsStore.js`, `persistance.js`, `radarEtat.js`, `reinitialisation.js` |
| Acquisition des offres | `collect.js`, `scan.js` — flux RSS/feeds marchands + scraping Firecrawl |
| Analyse des prix | `algorithm.js`, `productKey.js` — référence entre pairs + historique, publication des anomalies (D3) |

## Installation

```bash
npm install
cp .env.example .env    # JWT_SECRET est le seul réglage indispensable
```

## Lancer en local

```bash
npm start        # API sur http://localhost:3001
npm test         # 58 tests (vitest)
npm run lint
```

## Variables d'environnement

| Variable | Rôle |
| --- | --- |
| `JWT_SECRET` | **Obligatoire.** Signe les jetons de session. En changer déconnecte tous les membres. |
| `DB_PATH` | Chemin du fichier SQLite. En production : `/app/data/radarprix.sqlite`, sur le volume monté. En changer repart d'une base vide. |
| `PORT` | Port d'écoute (fourni par l'hébergeur). |
| `ADMIN_EMAIL` | Adresse qui obtient le rôle administrateur à l'inscription. |
| `CORS_ORIGINS` | Origines autorisées, séparées par des virgules. |
| `FIRECRAWL_API_KEY` | Clé du scraping SaaS (Firecrawl). Sans elle, seules les cibles à flux RSS/feed fonctionnent. |
| `SCAN_TOKEN` | Jeton qui permet au planificateur (cron) de déclencher les scans via `POST /api/admin/scan` + en-tête `x-scan-token`. |

## Détection

Le moteur de détection suit des **cibles** (`watch_targets`) : un produit et
de quoi aller le chercher.

- **Flux RSS / feeds marchands** (`feedUrl`) : RSS/Atom ou XML type Google
  Shopping, lus tels quels — aucune clé requise.
- **Scraping SaaS** (`domains`, ex. `["amazon.fr", "cdiscount.com"]`) :
  Firecrawl trouve les pages produits chez ces marchands et en extrait le
  contenu (markdown structuré). Nécessite `FIRECRAWL_API_KEY`.

À chaque scan, chaque cible produit des offres qui sont stockées dans
`snapshots`, analysées par `algorithm.js` (référence entre pairs du lot +
historique), puis les anomalies détectées sont publiées dans le flux unifié
`deals` (détecteur D3) — ce sont elles que `/api/feed` et `/api/deals` servent.

Déclenchement :

```bash
npm run scan                        # un scan complet, synchrone (cron)
# ou via l'API :
#   POST /api/admin/scan            (jeton admin, ou x-scan-token si SCAN_TOKEN est défini)
#   GET  /api/admin/scan/status     exécutions récentes + santé des canaux
#   GET/POST/PATCH/DELETE /api/admin/targets…
```

Un planificateur (Railway cron, cron-job.org…) peut appeler
`POST /api/admin/scan` avec l'en-tête `x-scan-token`.

## Déploiement

Railway : `npm start` est détecté automatiquement. Le fichier SQLite **doit**
être sur un disque persistant, sinon les comptes repartent de zéro à chaque
redéploiement. Une sauvegarde est écrite à chaque démarrage et conservée à
côté de la base.

Vercel ne convient pas pour ce service : ses fonctions sont sans état et ne
gardent pas de fichier SQLite entre deux appels.

## Canal Telegram

Publication automatique des deals sur `@radarprix`, en fin de cycle de scan.
Le module (`src/telegram.js`) lit la table `deals` ; il ne détecte rien et ne
touche ni à l'algorithme ni aux endpoints existants.

Variables à ajouter sur Railway :

| Variable | Défaut | Rôle |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Jeton BotFather de `@RADARPRIX_BOT`. Sans lui, le module ne fait rien. |
| `TELEGRAM_CHANNEL_ID` | `-1003927419198` | Identifiant numérique ou `@nom` |
| `TELEGRAM_ENABLED` | `false` | Interrupteur général |
| `TELEGRAM_DRY_RUN` | `true` | Journalise le message au lieu de l'envoyer |
| `TELEGRAM_DELAY_MINUTES` | `30` | Avance laissée aux inscrits sur le canal public |
| `TELEGRAM_DAILY_CAP` | `15` | Messages par jour au maximum |
| `TELEGRAM_MIN_DISCOUNT_PCT` | `25` | Remise minimum |
| `TELEGRAM_MIN_SELLERS` | `0` | Marchands comparés minimum — voir ci-dessous |
| `TELEGRAM_MIN_PRICE_EUR` | `15` | Prix plancher |
| `TELEGRAM_SPACING_MS` | `4000` | Espacement entre deux envois |

**Pour allumer :** poser `TELEGRAM_BOT_TOKEN`, puis `TELEGRAM_ENABLED=true`.
Laisser `TELEGRAM_DRY_RUN=true` un cycle pour lire les messages dans les
journaux avant de le passer à `false`.

**Pourquoi `TELEGRAM_MIN_SELLERS` vaut 0 et non 3.** Mesuré sur les 71 offres
publiées le 23 août 2026 : aucune n'a plus d'un marchand comparé. Un catalogue
marchand n'a qu'un vendeur par produit, et un prix barré d'agrégateur n'est pas
une médiane. À trois, le module ne publierait jamais rien. Le réglage existe
pour le jour où le réseau d'affiliation apportera plusieurs marchands sur un
même article.

Pour la même raison, le message n'annonce « Prix habituel constaté chez N
marchands » que si N marchands l'ont réellement pratiqué ; sinon il nomme la
vraie provenance du prix barré.

```bash
npm run telegram:dry   # montre les messages qui partiraient, sans rien envoyer
```
