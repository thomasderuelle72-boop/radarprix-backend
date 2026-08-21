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

/**
 * Jusqu'où la conversation est masquée pour ce membre. 0 = rien de masqué.
 * Le repère est un identifiant de message et non une date : deux messages
 * envoyés dans la même seconde ne peuvent pas se départager par la date,
 * les dates SQLite s'arrêtant à la seconde.
 */
function repereMasquage(userId, otherUserId) {
  const ligne = db
    .prepare("SELECT hidden_until_id FROM conversation_state WHERE user_id = ? AND other_user_id = ?")
    .get(userId, otherUserId);
  return ligne ? ligne.hidden_until_id : 0;
}

function listConversation(userId, otherUserId, limit = 200) {
  return db
    .prepare(
      `SELECT m.id, m.body, m.created_at, m.from_user_id, m.read_at,
              COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url
       FROM messages m JOIN users u ON u.id = m.from_user_id
       WHERE ((m.from_user_id = ? AND m.to_user_id = ?)
          OR (m.from_user_id = ? AND m.to_user_id = ?))
         AND m.id > ?
       ORDER BY m.id ASC LIMIT ?`
    )
    .all(userId, otherUserId, otherUserId, userId, repereMasquage(userId, otherUserId), limit);
}

/**
 * Masque la conversation pour CE membre seulement — l'autre garde la sienne
 * intacte. Renvoie le repère posé, c'est-à-dire l'identifiant du dernier
 * message échangé au moment de la suppression.
 */
function masquerConversation(userId, otherUserId) {
  const dernier = db
    .prepare(
      `SELECT MAX(id) AS id FROM messages
       WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`
    )
    .get(userId, otherUserId, otherUserId, userId);
  const repere = dernier?.id || 0;
  // Un message masqué n'a plus de lecteur : le laisser "non lu" ferait
  // compter éternellement une pastille pour une conversation invisible.
  db.prepare(
    `UPDATE messages SET read_at = datetime('now')
     WHERE to_user_id = ? AND from_user_id = ? AND read_at IS NULL AND id <= ?`
  ).run(userId, otherUserId, repere);
  db.prepare(
    `INSERT INTO conversation_state (user_id, other_user_id, hidden_until_id, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, other_user_id)
     DO UPDATE SET hidden_until_id = excluded.hidden_until_id, updated_at = excluded.updated_at`
  ).run(userId, otherUserId, repere);
  return repere;
}

/**
 * Supprime un message qu'on a soi-même envoyé. Le filtre sur from_user_id
 * fait partie de la requête et non d'un test préalable : c'est ce qui rend
 * impossible la suppression du message d'un autre, même en devinant son
 * identifiant.
 */
function supprimerMessage(userId, messageId) {
  const info = db
    .prepare("DELETE FROM messages WHERE id = ? AND from_user_id = ? AND to_user_id IS NOT NULL")
    .run(messageId, userId);
  return info.changes > 0;
}

/**
 * Remet une conversation en non-lu : le dernier message reçu redevient en
 * attente. Sert à « j'y répondrai plus tard » — sans ça, ouvrir un fil par
 * curiosité effaçait définitivement le rappel.
 */
function marquerConversationNonLue(userId, otherUserId) {
  const dernier = db
    .prepare(
      `SELECT MAX(id) AS id FROM messages
       WHERE to_user_id = ? AND from_user_id = ? AND id > ?`
    )
    .get(userId, otherUserId, repereMasquage(userId, otherUserId));
  if (!dernier?.id) return false;
  const info = db.prepare("UPDATE messages SET read_at = NULL WHERE id = ?").run(dernier.id);
  return info.changes > 0;
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
    .prepare(
      `SELECT COUNT(*) AS n FROM messages m
       WHERE m.to_user_id = ? AND m.read_at IS NULL
         AND m.id > COALESCE((
           SELECT hidden_until_id FROM conversation_state
           WHERE user_id = m.to_user_id AND other_user_id = m.from_user_id
         ), 0)`
    )
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
         last_msg.id AS last_id,
         last_msg.body AS last_body,
         last_msg.created_at AS last_at,
         last_msg.from_user_id AS last_from,
         last_msg.read_at AS last_read_at,
         (SELECT COUNT(*) FROM messages nl
           WHERE nl.from_user_id = other.id AND nl.to_user_id = ? AND nl.read_at IS NULL
             AND nl.id > masque.repere) AS non_lus
       FROM (
         SELECT DISTINCT CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END AS other_id
         FROM messages
         WHERE to_user_id IS NOT NULL AND (from_user_id = ? OR to_user_id = ?)
       ) AS convo
       JOIN users other ON other.id = convo.other_id
       -- Repère de masquage propre à ce membre : une conversation supprimée
       -- ne réapparaît que si l'autre écrit à nouveau.
       JOIN (
         SELECT convo2.other_id AS oid, COALESCE(cs.hidden_until_id, 0) AS repere
         FROM (
           SELECT DISTINCT CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END AS other_id
           FROM messages
           WHERE to_user_id IS NOT NULL AND (from_user_id = ? OR to_user_id = ?)
         ) AS convo2
         LEFT JOIN conversation_state cs ON cs.user_id = ? AND cs.other_user_id = convo2.other_id
       ) AS masque ON masque.oid = other.id
       JOIN messages last_msg ON last_msg.id = (
         SELECT id FROM messages
         WHERE ((from_user_id = ? AND to_user_id = other.id) OR (from_user_id = other.id AND to_user_id = ?))
           AND id > masque.repere
         ORDER BY id DESC LIMIT 1
       )
       -- Sur l'identifiant du dernier message, pas sur sa date : les dates
       -- SQLite s'arrêtent à la seconde, et deux conversations actives dans
       -- la même seconde se seraient classées au hasard.
       ORDER BY last_msg.id DESC`
    )
    .all(userId, userId, userId, userId, userId, userId, userId, userId, userId, userId);
}

module.exports = {
  sendMessage,
  listPublicMessages,
  listConversation,
  markConversationRead,
  countUnreadMessages,
  listConversationsFor,
  masquerConversation,
  supprimerMessage,
  marquerConversationNonLue,
};
