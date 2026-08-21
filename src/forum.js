// forum.js — Catégories, sujets et réponses du forum.
//
// Extrait de db.js pour la même raison que la messagerie : c'est un domaine
// clos, qui ne partage avec le reste que la table users, et sa présence au
// milieu du stockage des prix n'aidait personne à s'y retrouver.
//
// La création des tables et l'insertion des catégories par défaut restent
// dans db.js : elles s'exécutent au chargement de la connexion, et les
// déplacer ici les ferait dépendre de l'ordre des require().
const { db } = require("./db");

// ── Forum : catégories, sujets, réponses ─────────────────────────
/**
 * Catégories du forum, avec de quoi montrer si l'endroit est vivant :
 * nombre de sujets, nombre total de réponses, et le dernier sujet actif
 * (titre, auteur, date). Sans ces informations, la liste des catégories
 * n'affichait qu'un compteur de sujets — impossible de savoir si quelqu'un
 * y écrit encore.
 */
function listForumCategories() {
  return db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM forum_threads t WHERE t.category_id = c.id) AS thread_count,
              (SELECT COUNT(*) FROM forum_replies r
                 JOIN forum_threads t ON t.id = r.thread_id
                WHERE t.category_id = c.id) AS reply_count,
              last.title AS last_title,
              last.id AS last_thread_id,
              last.activity_at AS last_activity_at,
              last.author AS last_author
       FROM forum_categories c
       LEFT JOIN (
         SELECT t.category_id,
                t.id,
                t.title,
                COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author,
                COALESCE((SELECT MAX(r.created_at) FROM forum_replies r WHERE r.thread_id = t.id), t.created_at) AS activity_at
           FROM forum_threads t
           JOIN users u ON u.id = t.user_id
       ) AS last
         ON last.category_id = c.id
        AND last.activity_at = (
              SELECT MAX(COALESCE((SELECT MAX(r2.created_at) FROM forum_replies r2 WHERE r2.thread_id = t2.id), t2.created_at))
                FROM forum_threads t2 WHERE t2.category_id = c.id
            )
       GROUP BY c.id
       ORDER BY c.sort_order ASC`
    )
    .all();
}

function getForumCategoryBySlug(slug) {
  return db.prepare("SELECT * FROM forum_categories WHERE slug = ?").get(slug);
}

/** Sujets d'une catégorie, avec auteur, nombre de réponses et date de dernière activité. */
function listForumThreads(categoryId, limit = 50) {
  return db
    .prepare(
      `SELECT t.id, t.title, t.created_at, t.user_id,
              COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url,
              (SELECT COUNT(*) FROM forum_replies r WHERE r.thread_id = t.id) AS reply_count,
              COALESCE(
                (SELECT MAX(r.created_at) FROM forum_replies r WHERE r.thread_id = t.id),
                t.created_at
              ) AS last_activity_at
       FROM forum_threads t JOIN users u ON u.id = t.user_id
       WHERE t.category_id = ?
       ORDER BY last_activity_at DESC
       LIMIT ?`
    )
    .all(categoryId, limit);
}

function getForumThread(threadId) {
  return db
    .prepare(
      `SELECT t.*, c.slug AS category_slug, c.name AS category_name,
              COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url
       FROM forum_threads t
       JOIN users u ON u.id = t.user_id
       JOIN forum_categories c ON c.id = t.category_id
       WHERE t.id = ?`
    )
    .get(threadId);
}

function createForumThread(categoryId, userId, title, body) {
  const info = db
    .prepare("INSERT INTO forum_threads (category_id, user_id, title, body) VALUES (?, ?, ?, ?)")
    .run(categoryId, userId, title, body);
  return getForumThread(info.lastInsertRowid);
}

function listForumReplies(threadId) {
  return db
    .prepare(
      `SELECT r.id, r.body, r.created_at, r.user_id,
              COALESCE(NULLIF(u.pseudo, ''), 'Membre #' || u.id) AS author, u.avatar_url
       FROM forum_replies r JOIN users u ON u.id = r.user_id
       WHERE r.thread_id = ? ORDER BY r.created_at ASC`
    )
    .all(threadId);
}

function addForumReply(threadId, userId, body) {
  db.prepare("INSERT INTO forum_replies (thread_id, user_id, body) VALUES (?, ?, ?)").run(threadId, userId, body);

  // Prévenir l'auteur du sujet. Le require est local pour éviter un cycle :
  // notifications.js s'appuie sur db.js, que ce module charge déjà.
  try {
    const sujet = db.prepare("SELECT user_id, title FROM forum_threads WHERE id = ?").get(threadId);
    if (sujet) {
      require("./notifications").creerNotification({
        userId: sujet.user_id,
        acteurId: userId, // creerNotification se tait si c'est la même personne
        type: "reponse_forum",
        titre: "Nouvelle réponse à votre sujet",
        corps: sujet.title,
        cibleVue: "forum-thread",
        cibleId: threadId,
      });
    }
  } catch (e) {
    // Une notification perdue ne doit jamais faire échouer la publication
    // que le membre attend.
    console.error(`[forum] notification non créée : ${e.message}`);
  }

  return listForumReplies(threadId);
}

module.exports = {
  listForumCategories,
  getForumCategoryBySlug,
  listForumThreads,
  getForumThread,
  createForumThread,
  listForumReplies,
  addForumReply,
};
