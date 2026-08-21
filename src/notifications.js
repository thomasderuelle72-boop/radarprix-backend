// notifications.js — Ce qui s'est passé pendant votre absence.
//
// Le site savait compter les messages privés non lus, et rien d'autre. Or un
// membre qui publie un deal, ouvre un sujet ou suit un produit provoque des
// évènements qui le concernent — une réponse, un commentaire, une baisse de
// prix — et aucun ne lui parvenait sans qu'il aille les chercher lui-même.
//
// Deux règles gouvernent ce module, et elles expliquent l'essentiel du code :
//
//   1. On ne se notifie jamais soi-même. Répondre à son propre sujet ou
//      commenter son propre deal ne doit produire aucune pastille — c'est
//      l'erreur la plus courante de ce genre de système, et la plus agaçante.
//
//   2. Une notification porte de quoi y retourner. Un libellé sans
//      destination oblige le membre à retrouver lui-même ce dont on lui
//      parle, ce qui la rend pire qu'inutile.
const { db } = require("./db");

/* Natures possibles. Vocabulaire contrôlé plutôt que chaînes libres : une
   faute de frappe rendrait une notification invisible au filtrage sans
   qu'aucune erreur ne soit levée. */
const TYPES = ["reponse_forum", "commentaire_deal", "nouvel_abonne", "alerte_prix", "moderation"];

db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    titre TEXT NOT NULL,
    corps TEXT,

    -- De quoi y retourner : une vue du site et l'identifiant de la chose
    -- concernée. Le frontend décide comment les combiner en navigation.
    cible_vue TEXT,
    cible_id TEXT,

    -- Qui a provoqué l'évènement, quand quelqu'un l'a provoqué. NULL pour
    -- ce qui vient de la machine (une alerte de prix, par exemple).
    acteur_id INTEGER REFERENCES users(id) ON DELETE SET NULL,

    lu_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_membre ON notifications(user_id, lu_at, created_at);
`);

/**
 * Crée une notification.
 *
 * Renvoie null sans rien écrire quand le destinataire est aussi l'acteur :
 * personne n'a besoin d'être averti de sa propre action.
 */
function creerNotification({ userId, type, titre, corps = null, cibleVue = null, cibleId = null, acteurId = null }) {
  if (!TYPES.includes(type)) {
    throw new Error(`Type de notification inconnu : "${type}" (attendus : ${TYPES.join(", ")})`);
  }
  if (!userId || !titre) throw new Error("Une notification doit porter un destinataire et un titre.");
  if (acteurId && Number(acteurId) === Number(userId)) return null;

  const info = db
    .prepare(
      `INSERT INTO notifications (user_id, type, titre, corps, cible_vue, cible_id, acteur_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, type, titre, corps, cibleVue, cibleId == null ? null : String(cibleId), acteurId);
  return info.lastInsertRowid;
}

/** Nombre de notifications non lues d'un membre. */
function compterNonLues(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND lu_at IS NULL").get(userId).n;
}

/** Les dernières notifications, non lues d'abord. */
function listerNotifications(userId, limite = 40) {
  return db
    .prepare(
      `SELECT n.*, u.pseudo AS acteur_pseudo, u.avatar_url AS acteur_avatar
       FROM notifications n
       LEFT JOIN users u ON u.id = n.acteur_id
       WHERE n.user_id = ?
       ORDER BY n.lu_at IS NOT NULL, n.created_at DESC
       LIMIT ?`
    )
    .all(userId, Math.min(100, Math.max(1, limite)));
}

/**
 * Marque comme lues. Sans identifiants, marque tout le lot du membre.
 * Le filtre sur user_id est présent dans les deux cas : sans lui, un membre
 * pourrait marquer les notifications d'un autre en devinant un identifiant.
 */
function marquerLues(userId, ids = null) {
  if (Array.isArray(ids) && ids.length > 0) {
    const trous = ids.map(() => "?").join(",");
    return db
      .prepare(`UPDATE notifications SET lu_at = datetime('now') WHERE user_id = ? AND lu_at IS NULL AND id IN (${trous})`)
      .run(userId, ...ids).changes;
  }
  return db.prepare("UPDATE notifications SET lu_at = datetime('now') WHERE user_id = ? AND lu_at IS NULL").run(userId)
    .changes;
}

/**
 * Purge les notifications lues au-delà d'un certain âge. Sans elle, la table
 * grossit indéfiniment avec des lignes que plus personne ne relira.
 */
function purgerNotifications(jours = 60) {
  return db
    .prepare(`DELETE FROM notifications WHERE lu_at IS NOT NULL AND lu_at < datetime('now', '-${Number(jours) || 60} days')`)
    .run().changes;
}

module.exports = { creerNotification, compterNonLues, listerNotifications, marquerLues, purgerNotifications, TYPES };
