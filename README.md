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
