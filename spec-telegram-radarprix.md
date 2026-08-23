# Spec — Publication automatique des deals sur Telegram (RadarPrix)

## Contexte du projet

Backend Node.js/Express déployé sur Railway, base SQLite via `better-sqlite3`.

Architecture existante à ne pas casser :
- Un **cron** scanne le catalogue en tâche de fond via SerpApi et stocke les prix en base.
- `/api/deals` sert les résultats déjà calculés (instantané, sans appel API).
- L'algorithme de détection compare le prix d'un vendeur à la **médiane inter-vendeurs** et à l'**historique du produit**, avec filtrage des accessoires/hors-sujet.
- Il existe déjà : historique de prix, badge « prix le plus bas jamais vu », détection de tendances (baisse sur plusieurs jours), notifications sur favoris, tableau de bord admin.

Variables d'environnement déjà configurées sur Railway : `SERPAPI_KEY`, `JWT_SECRET`, `ADMIN_EMAIL`.

## État de l'infrastructure Telegram

Tout est déjà en place côté Telegram — il n'y a rien à créer ni à configurer de ce côté :
- Bot `@RADARPRIX_BOT` créé, token fourni en variable d'environnement
- Canal public `@radarprix`, ID numérique `-1003927419198`
- Bot ajouté comme **administrateur** du canal, droit « Publier des messages » actif
- Envoi vérifié manuellement : `sendMessage` renvoie `ok: true`

## Avant d'écrire du code

1. Lis le code du cron, le schéma SQLite et le handler `/api/deals` pour reprendre les noms de tables/colonnes existants. **N'invente pas de schéma.**
2. Repère comment le badge « prix le plus bas jamais vu » et le calcul de médiane sont implémentés — le module de publication doit les réutiliser, pas les recalculer.
3. Propose-moi le plan de fichiers avant de commencer.

## Objectif

Un module qui publie automatiquement les meilleurs deals détectés sur un canal Telegram, sans intervention manuelle, sans doublon, et sans jamais faire planter le cron existant.

## Périmètre

### 1. Configuration

Nouvelles variables d'environnement, toutes avec valeur par défaut sensée :

| Variable | Défaut | Rôle |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Token BotFather de `@RADARPRIX_BOT` |
| `TELEGRAM_CHANNEL_ID` | `-1003927419198` | Canal `@radarprix`. Le code doit accepter aussi bien l'ID numérique que le format `@username` |
| `TELEGRAM_ENABLED` | `false` | Kill switch global |
| `TELEGRAM_DRY_RUN` | `true` | Log le message au lieu de l'envoyer |
| `TELEGRAM_DELAY_MINUTES` | `30` | Délai entre détection et publication publique |
| `TELEGRAM_DAILY_CAP` | `15` | Nombre max de posts par jour |
| `TELEGRAM_MIN_DISCOUNT_PCT` | `25` | Écart minimum vs médiane |
| `TELEGRAM_MIN_SELLERS` | `3` | Vendeurs minimum pour fiabiliser la médiane |
| `TELEGRAM_MIN_PRICE_EUR` | `15` | Sous ce prix, on ne publie pas |

### 2. Schéma

Nouvelle table `telegram_posts` :
- `id`, `product_id`, `price_cents`, `message_id`, `posted_at`
- Index sur `product_id` et `posted_at`

Elle sert à la déduplication **et** doit survivre aux redémarrages (Railway redéploie souvent).

### 3. Règles de sélection

Un deal est éligible si **toutes** ces conditions sont vraies :
- Écart vs médiane ≥ `TELEGRAM_MIN_DISCOUNT_PCT`
- Nombre de vendeurs ≥ `TELEGRAM_MIN_SELLERS`
- Prix ≥ `TELEGRAM_MIN_PRICE_EUR`
- Pas déjà publié pour ce produit, **sauf** si le nouveau prix est au moins 5 % sous le dernier prix publié **et** que 48 h se sont écoulées
- Détecté depuis au moins `TELEGRAM_DELAY_MINUTES` (les inscrits sont notifiés avant le canal public — c'est volontaire, c'est l'argument d'inscription)

Priorisation quand il y a plus de candidats que le cap journalier : d'abord les produits portant le badge « prix le plus bas jamais vu », puis par écart décroissant vs médiane.

### 4. Format du message

Utiliser `parse_mode: "HTML"` (et non MarkdownV2, dont l'échappement est pénible). Échapper `&`, `<`, `>` dans tout contenu dynamique.

Structure :

```
🔻 <b>{nom du produit}</b>

<b>{prix} €</b>  <s>{médiane} €</s>   −{écart} %
{badge « 🏆 Prix le plus bas jamais vu » si applicable}

Vendeur : {marchand}
Médiane sur {n} vendeurs

👉 {lien}
```

Le lien pointe vers **la fiche produit sur RadarPrix**, jamais directement vers le marchand — c'est tout l'intérêt de l'opération. Ajoute `?utm_source=telegram&utm_medium=social&utm_campaign=auto`.

### 5. Robustesse

- Le module s'exécute après le cycle de scan et **ne doit jamais propager d'exception** au cron. Try/catch autour de tout, log l'erreur, continue.
- Sur HTTP 429, respecte le champ `retry_after` renvoyé par Telegram, avec backoff exponentiel et 3 tentatives max.
- Espacer les envois d'au moins 4 secondes (l'API limite à ~20 messages/minute vers un même canal — on garde une marge).
- Si `TELEGRAM_ENABLED=false` ou token absent : ne rien faire, logger une ligne, sortir proprement.

### 6. Admin

Dans le tableau de bord admin existant, ajouter une section :
- État du module (actif / dry-run / désactivé) et compteur de posts du jour
- Les 20 derniers deals publiés, avec lien vers le message Telegram
- Les deals éligibles en attente de publication, avec un bouton « publier maintenant » et un bouton « ignorer »

Routes protégées par le même middleware d'authentification admin que le reste.

### 7. Script de test

Un script npm (`npm run telegram:dry`) qui prend les deals actuels, applique les règles de sélection et affiche en console les messages qui seraient envoyés, sans rien envoyer. Doit fonctionner en local sans toucher à la prod.

## Hors périmètre — ne pas modifier

- L'algorithme de détection (médiane, historique, filtrage des accessoires)
- Le cron de scan lui-même, au-delà de l'appel au nouveau module en fin de cycle
- Les endpoints existants, le système de comptes, le frontend
- Pas de nouvelle dépendance lourde : `node-telegram-bot-api` ou un simple `fetch` vers l'API Bot suffisent. Justifie ton choix.

## Critères d'acceptation

1. `TELEGRAM_DRY_RUN=true` affiche les messages en console et n'envoie rien.
2. Deux cycles de cron consécutifs ne republient pas le même deal.
3. Un redémarrage du service ne provoque pas de doublons.
4. Une erreur Telegram (token invalide, canal introuvable) est loggée et le cron continue normalement.
5. Le cap journalier est respecté même si 50 deals sont éligibles.
6. Aucune modification du comportement de `/api/deals`.

## Livraison

Commit sur `main` avec un message clair, plus une section dans le README listant les nouvelles variables d'environnement à ajouter sur Railway.
