// db.js — Stockage de l'historique des prix (SQLite, fichier local).
// Aucune dépendance externe à un service payant : juste un fichier .sqlite.
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "radarprix.sqlite");
// Le dossier data/ n'existe pas toujours après un déploiement (Git ne suit pas
// les dossiers vides) : on le crée nous-mêmes pour éviter un crash au démarrage.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    category TEXT DEFAULT 'tout',
    name TEXT NOT NULL,
    seller TEXT,
    price REAL NOT NULL,
    url TEXT,
    img TEXT,
    scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_query ON snapshots(query);
  CREATE INDEX IF NOT EXISTS idx_snapshots_name ON snapshots(name);
`);

/** Enregistre une liste d'offres observées lors d'un scan. */
function insertSnapshots(query, category, offers) {
  const stmt = db.prepare(`
    INSERT INTO snapshots (query, category, name, seller, price, url, img)
    VALUES (@query, @category, @name, @seller, @price, @url, @img)
  `);
  const insertMany = db.transaction((rows) => {
    for (const row of rows) stmt.run(row);
  });
  insertMany(
    offers.map((o) => ({
      query,
      category,
      name: o.name,
      seller: o.seller || null,
      price: o.price,
      url: o.url || null,
      img: o.img || null,
    }))
  );
}

/**
 * Historique des prix pour un même produit (regroupé par nom normalisé),
 * utilisé pour calculer une moyenne de référence.
 */
function priceHistoryFor(name, excludeLastMinutes = 0) {
  const rows = db
    .prepare(
      `SELECT price FROM snapshots
       WHERE name = ?
       ${excludeLastMinutes ? "AND scraped_at < datetime('now', ?)" : ""}
       ORDER BY scraped_at DESC LIMIT 200`
    )
    .all(...(excludeLastMinutes ? [name, `-${excludeLastMinutes} minutes`] : [name]));
  return rows.map((r) => r.price);
}

/** Dernier scan (les offres les plus récentes) pour une requête donnée. */
function latestSnapshots(query, limit = 30) {
  return db
    .prepare(
      `SELECT * FROM snapshots
       WHERE query = ?
       AND scraped_at = (SELECT MAX(scraped_at) FROM snapshots WHERE query = ?)
       LIMIT ?`
    )
    .all(query, query, limit);
}

module.exports = { db, insertSnapshots, priceHistoryFor, latestSnapshots };
