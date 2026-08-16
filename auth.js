// auth.js — Comptes utilisateurs : mots de passe hachés (jamais stockés
// en clair), sessions par jeton JWT. Aucun service tiers requis.
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ⚠️ En production, cette valeur DOIT être définie dans les variables
// d'environnement (Railway → Variables → JWT_SECRET), jamais codée en dur.
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = "30d";

function assertSecretConfigured() {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET manquante — ajoute-la dans le fichier .env");
  }
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function generateToken(user) {
  assertSecretConfigured();
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function verifyToken(token) {
  assertSecretConfigured();
  return jwt.verify(token, JWT_SECRET); // lève une exception si invalide/expiré
}

/** Middleware Express : exige un jeton valide dans l'en-tête Authorization. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Connexion requise." });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Session invalide ou expirée, reconnecte-toi." });
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email) {
  return typeof email === "string" && EMAIL_RE.test(email);
}

module.exports = { hashPassword, verifyPassword, generateToken, verifyToken, requireAuth, isValidEmail };
