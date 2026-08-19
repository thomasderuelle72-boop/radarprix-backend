# RadarPrix — Backend

Backend qui scanne réellement les marchands (via Google Shopping / SerpApi)
et détecte les anomalies de prix par algorithme — **aucun token Claude/IA n'est utilisé ici**.

## Comment ça marche

1. `src/serpapi.js` interroge Google Shopping (multi-marchands) pour un produit donné.
2. `src/db.js` enregistre chaque prix observé dans une base SQLite locale (`data/radarprix.sqlite`), qui constitue l'historique.
3. `src/algorithm.js` compare chaque prix à deux références :
   - la médiane des offres du même scan (fonctionne dès le 1er scan),
   - la moyenne historique de ce produit (s'améliore avec le temps).
   Un écart ≥60% = "erreur", ≥40% = "deal".
4. `src/server.js` expose une API que ton site (le front) appelle.
5. `src/cron.js` (optionnel) relance des scans toutes les 30 min pour construire l'historique même sans visiteur.

## Installation

```bash
npm install
cp .env.example .env
# puis édite .env et colle ta clé SerpApi (compte gratuit sur serpapi.com)
```

## Lancer en local

```bash
npm start        # démarre l'API sur http://localhost:3001
npm run test      # vérifie que l'algorithme de détection fonctionne (données simulées)
npm run cron      # (optionnel, dans un 2e terminal) scans automatiques toutes les 30 min
```

## Routes API

- `POST /api/scan` `{ "query": "PS5 slim", "category": "gaming" }`
  → lance un scan réel, retourne les offres suspectes (deal/erreur).
- `POST /api/scan-watchlist` `{ "list": "hightech" }`
  → scanne toutes les requêtes prédéfinies d'une catégorie (voir `WATCHLIST` dans `server.js`).
- `GET /api/latest?query=ps5+slim`
  → relit le dernier scan déjà enregistré, sans consommer de quota SerpApi.
- `GET /api/health`
  → vérifie que le serveur tourne.

## Déploiement (mise en ligne)

Ce backend a besoin de tourner en continu (pas un simple artefact) :

1. **Railway.app** ou **Render.com** (plans gratuits disponibles) : connecte ton dépôt GitHub, ils détectent `npm start` automatiquement. Ajoute `SERPAPI_KEY` dans leurs variables d'environnement (jamais dans le code).
2. Si tu veux le scan automatique (`cron.js`), ajoute un second "service" sur la même plateforme avec la commande `npm run cron`.
3. Le fichier `data/radarprix.sqlite` doit être sur un **disque persistant** (Railway/Render le proposent) — sinon l'historique repart de zéro à chaque redéploiement.

⚠️ Vercel n'est **pas recommandé** ici : ses fonctions sont "sans état" et ne gardent pas de fichier SQLite entre deux appels.

## Brancher le front dessus

Dans le site (l'artifact React), remplace les appels à l'API Claude par de simples appels à ce backend, par exemple :

```js
const res = await fetch("https://TON-BACKEND.up.railway.app/api/scan-watchlist", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ list: "hightech" }),
});
const { items } = await res.json();
```

## Coûts

- SerpApi : essai gratuit (~100 requêtes/mois), puis plans payants selon le volume.
- Hébergement (Railway/Render) : plan gratuit suffisant pour démarrer, payant si trafic important.
- Aucun coût lié à Claude/l'IA sur ce backend.
