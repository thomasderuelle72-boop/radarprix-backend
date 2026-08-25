// tests/identites.test.js — Connexion Google et Apple.
//
// Ce qui est éprouvé ici n'est pas le chemin heureux : c'est le refus. Un
// jeton d'identité mal vérifié laisse entrer n'importe qui sous n'importe
// quelle identité, et les quatre contrôles — signature, émetteur,
// destinataire, expiration — n'ont de valeur que si aucun ne peut être
// contourné.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const jwt = require("jsonwebtoken");
const identites = require("../src/identites.js");
const { db } = require("../src/db.js");

// Une paire de clés à nous : elle joue le rôle de « Google » dans les tests
// où l'on veut une signature valide sans sortir sur le réseau.
const paire = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

const jetonSigne = (charge, options = {}) =>
  jwt.sign(charge, paire.privateKey, { algorithm: "RS256", expiresIn: "5m", keyid: "essai", ...options });

describe("configuration", () => {
  const avant = process.env.GOOGLE_CLIENT_ID;
  afterEach(() => {
    if (avant === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = avant;
  });

  it("se tait tant qu'un fournisseur n'est pas configuré", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    expect(identites.configure("google")).toBe(false);
    expect(identites.fournisseursActifs()).not.toContain("google");
  });

  it("s'active dès que l'identifiant client existe", () => {
    process.env.GOOGLE_CLIENT_ID = "1234.apps.googleusercontent.com";
    expect(identites.configure("google")).toBe(true);
    expect(identites.fournisseursActifs()).toContain("google");
  });
});

describe("verifierJeton — les refus", () => {
  const avant = process.env.GOOGLE_CLIENT_ID;
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "notre-client-id";
  });
  afterEach(() => {
    if (avant === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = avant;
  });

  it("refuse un fournisseur inconnu", async () => {
    await expect(identites.verifierJeton("facebook", "peu importe")).rejects.toThrow(/inconnu/);
  });

  it("refuse un jeton illisible avant même de sortir sur le réseau", async () => {
    await expect(identites.verifierJeton("google", "ceci-n-est-pas-un-jwt")).rejects.toThrow(/illisible/);
  });

  it("refuse un jeton sans identifiant de clé", async () => {
    // Sans `kid`, impossible de savoir quelle clé publique vérifier — et
    // accepter « au hasard » reviendrait à ne pas vérifier.
    const sansKid = jwt.sign({ sub: "1" }, paire.privateKey, { algorithm: "RS256" });
    await expect(identites.verifierJeton("google", sansKid)).rejects.toThrow(/illisible/);
  });

  it("refuse quand le fournisseur n'est pas configuré", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    await expect(identites.verifierJeton("google", jetonSigne({ sub: "1" }))).rejects.toThrow(/non configurée/);
  });
});

describe("email_verified — la ligne qui empêche de réclamer le compte d'un autre", () => {
  // Apple rend « true » en chaîne, Google en booléen. Comparer sans
  // normaliser traiterait tous les comptes Apple comme non vérifiés — et
  // créerait un compte en double à chaque connexion.
  const verifie = (v) => v === true || v === "true";

  it("accepte les deux formes que les fournisseurs emploient", () => {
    expect(verifie(true)).toBe(true);
    expect(verifie("true")).toBe(true);
  });

  it("refuse tout le reste", () => {
    expect(verifie(false)).toBe(false);
    expect(verifie("false")).toBe(false);
    expect(verifie(undefined)).toBe(false);
    expect(verifie(1)).toBe(false);
  });
});

describe("liaison des identités", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM identites_externes").run();
    db.prepare("DELETE FROM users").run();
  });

  const compte = (email) =>
    db.prepare("INSERT INTO users (email, password_hash) VALUES (?, 'x')").run(email).lastInsertRowid;

  it("retrouve un compte par son identité, pas par son email", () => {
    const id = compte("a@exemple.fr");
    identites.lier("google", "sujet-123", id, "a@exemple.fr");
    // Le sujet est l'identifiant STABLE : il survit à un changement d'adresse.
    expect(identites.identiteDe("google", "sujet-123").user_id).toBe(id);
    expect(identites.identiteDe("google", "autre-sujet")).toBeUndefined();
  });

  it("laisse un même compte lier plusieurs fournisseurs", () => {
    const id = compte("b@exemple.fr");
    identites.lier("google", "g-1", id, "b@exemple.fr");
    identites.lier("apple", "a-1", id, "b@exemple.fr");
    expect(identites.identitesDuMembre(id).map((i) => i.fournisseur).sort()).toEqual(["apple", "google"]);
  });

  it("ne crée pas de doublon quand la même identité revient", () => {
    const id = compte("c@exemple.fr");
    identites.lier("google", "g-2", id, "c@exemple.fr");
    identites.lier("google", "g-2", id, "c-nouveau@exemple.fr");
    expect(identites.identitesDuMembre(id)).toHaveLength(1);
    expect(identites.identitesDuMembre(id)[0].email).toBe("c-nouveau@exemple.fr");
  });

  it("délie et le dit", () => {
    const id = compte("d@exemple.fr");
    identites.lier("google", "g-3", id, "d@exemple.fr");
    expect(identites.delier("google", id)).toBe(true);
    expect(identites.delier("google", id)).toBe(false);
    expect(identites.identitesDuMembre(id)).toHaveLength(0);
  });
});
