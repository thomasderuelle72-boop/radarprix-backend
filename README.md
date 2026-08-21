# RadarPrix — Backend

API du site : comptes, profils, forum, salon, messagerie privée, notifications,
deals publiés par les membres, modération. Base SQLite locale, persistée sur un
disque monté par l'hébergeur.

> **La machinerie de détection a été retirée.** Le backend ne va plus chercher
> d'offres nulle part : ni SerpApi, ni Bright Data, ni eBay, ni Awin, ni
> Strackr, ni les sitemaps marchands. Les détecteurs, la surveillance des
> fiches, la curation, le scoring et le cron ont été supprimés pour repartir
> d'une base propre. Les tables (`deals`, `snapshots`, `watched_urls`,
> `watched_prices`, `rejected_offers`, `watchlist`) sont conservées vides,
> ainsi que les routes qui les lisent : un futur moteur pourra s'y brancher
> sans migration.

## Ce qui tourne aujourd'hui

| Domaine | Modules |
| --- | --- |
| Comptes et sécurité | `auth.js`, `moderation.js` |
| Communauté | `forum.js`, `messagerie.js`, `notifications.js`, `badges.js`, `ranking.js`, `reputation.js` |
| Données | `db.js`, `dealsStore.js`, `persistance.js`, `radarEtat.js`, `reinitialisation.js` |
| Lecture des relevés | `algorithm.js`, `productKey.js` — sert à `/api/latest`, qui relit ce qui est déjà en base |

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

## Déploiement

Railway : `npm start` est détecté automatiquement. Le fichier SQLite **doit**
être sur un disque persistant, sinon les comptes repartent de zéro à chaque
redéploiement. Une sauvegarde est écrite à chaque démarrage et conservée à
côté de la base.

Vercel ne convient pas pour ce service : ses fonctions sont sans état et ne
gardent pas de fichier SQLite entre deux appels.
