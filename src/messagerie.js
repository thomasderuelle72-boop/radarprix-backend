// messagerie.js — Salon général et messages privés.
//
// Extrait de db.js, qui mêlait dans un seul fichier de deux mille lignes les
// membres, le forum, la modération, le catalogue et les badges. La messagerie
// en est le morceau le plus autonome : elle ne touche qu'à la table messages
// et ne connaît des membres que leur identifiant.
//
// La connexion reste détenue par db.js, comme pour dealsStore et watch : ce
// module la lui demande. L'inverse — db.js requérant celui-ci — créerait un
// cycle, et c'est pourquoi server.js importe désormais ces fonctions ici
// plutôt qu'à travers db.js.
const { db } = require("./db");

// ── Messages : salon général public (to_user_id NULL) + messages privés ──
function sendMessage(fromUserId, toUserId, body) {
  const info = db
    .prepare("INSERT INTO messages (from_user_id, to_user_id, body) VALUES (?, ?, ?)")
    .run(fromUserId, toUserId || null, body);
  return info.lastInsertRowid;
}

/**
 * Messages du salon général.
 *
 * afterId > 0 : les messages arrivés depuis, pour le sondage régulier.
 * afterId = 0 : le premier chargement. On renvoie alors les DERNIERS
 * messages, pas les premiers — sinon, passé une centaine de messages, un
 * visiteur qui arrive découvrait l'historique le plus ancien du salon et
 * devait attendre autant de sondages qu'il y a de pages pour rattraper la
 * conversation en cours.
 */
function listPublicMessages(afterId = 0, limit = 100) {
  if (afterId > 0) {
    return db
      .prepare(
        `SELECT m.id, m.body, m.created_at, u.id AS user_id,
                COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url
         FROM messages m JOIN users u ON u.id = m.from_user_id
         WHERE m.to_user_id IS NULL AND m.id > ?
         ORDER BY m.id ASC LIMIT ?`
      )
      .all(afterId, limit);
  }
  // Les N derniers, remis dans l'ordre chronologique pour l'affichage.
  return db
    .prepare(
      `SELECT * FROM (
         SELECT m.id, m.body, m.created_at, u.id AS user_id,
                COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url
         FROM messages m JOIN users u ON u.id = m.from_user_id
         WHERE m.to_user_id IS NULL
         ORDER BY m.id DESC LIMIT ?
       ) ORDER BY id ASC`
    )
    .all(limit);
}

function listConversation(userId, otherUserId, limit = 200) {
  return db
    .prepare(
      `SELECT m.id, m.body, m.created_at, m.from_user_id, m.read_at,
              COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url
       FROM messages m JOIN users u ON u.id = m.from_user_id
       WHERE (m.from_user_id = ? AND m.to_user_id = ?)
          OR (m.from_user_id = ? AND m.to_user_id = ?)
       ORDER BY m.id ASC LIMIT ?`
    )
    .all(userId, otherUserId, otherUserId, userId, limit);
}

/**
 * Marque comme lus les messages qu'un membre vient de recevoir dans une
 * conversation. Appelé à l'ouverture du fil : c'est le seul moment où l'on
 * sait de façon fiable que le destinataire les a sous les yeux.
 */
function markConversationRead(userId, otherUserId) {
  const info = db
    .prepare(
      `UPDATE messages SET read_at = datetime('now')
       WHERE to_user_id = ? AND from_user_id = ? AND read_at IS NULL`
    )
    .run(userId, otherUserId);
  return info.changes;
}

/** Total de messages privés en attente, toutes conversations confondues. */
function countUnreadMessages(userId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE to_user_id = ? AND read_at IS NULL")
    .get(userId).n;
}

/** Liste des conversations privées d'un utilisateur, avec le dernier message de chacune. */
function listConversationsFor(userId) {
  return db
    .prepare(
      `SELECT
         other.id AS user_id,
         COALESCE(NULLIF(other.pseudo, ''), 'Membre #' || other.id) AS display_name,
         other.avatar_url,
         last_msg.body AS last_body,
         last_msg.created_at AS last_at,
         last_msg.from_user_id AS last_from,
         (SELECT COUNT(*) FROM messages nl
           WHERE nl.from_user_id = other.id AND nl.to_user_id = ? AND nl.read_at IS NULL) AS non_lus
       FROM (
         SELECT DISTINCT CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END AS other_id
         FROM messages
         WHERE to_user_id IS NOT NULL AND (from_user_id = ? OR to_user_id = ?)
       ) AS convo
       JOIN users other ON other.id = convo.other_id
       JOIN messages last_msg ON last_msg.id = (
         SELECT id FROM messages
         WHERE (from_user_id = ? AND to_user_id = other.id) OR (from_user_id = other.id AND to_user_id = ?)
         ORDER BY id DESC LIMIT 1
       )
       -- Sur l'identifiant du dernier message, pas sur sa date : les dates
       -- SQLite s'arrêtent à la seconde, et deux conversations actives dans
       -- la même seconde se seraient classées au hasard.
       ORDER BY last_msg.id DESC`
    )
    .all(userId, userId, userId, userId, userId, userId);
}

module.exports = {
  sendMessage,
  listPublicMessages,
  listConversation,
  markConversationRead,
  countUnreadMessages,
  listConversationsFor,
};
