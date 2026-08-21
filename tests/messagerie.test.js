// Messagerie privée — suppression, non-lu, propriété d'un message.
//
// Ces trois fonctions ont en commun de porter sur des données partagées entre
// deux personnes : la question qui compte n'est jamais « est-ce que ça
// marche », mais « qu'arrive-t-il À L'AUTRE ». C'est ce que ces tests
// vérifient en premier.
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createUser, db } = require("../src/db.js");
const {
  sendMessage,
  listConversation,
  listConversationsFor,
  countUnreadMessages,
  markConversationRead,
  masquerConversation,
  supprimerMessage,
  marquerConversationNonLue,
} = require("../src/messagerie.js");

let alice;
let bob;
let compteur = 0;

beforeEach(() => {
  // Base partagée par les fichiers de test : des comptes neufs à chaque cas
  // évitent qu'une conversation d'un test précédent ne se mêle au suivant.
  compteur += 1;
  alice = createUser(`alice${compteur}@test.fr`, "x").id;
  bob = createUser(`bob${compteur}@test.fr`, "x").id;
});

describe("suppression d'une conversation", () => {
  it("vide le fil pour celui qui supprime", () => {
    sendMessage(alice, bob, "salut");
    sendMessage(bob, alice, "salut à toi");

    masquerConversation(alice, bob);

    expect(listConversation(alice, bob)).toHaveLength(0);
    expect(listConversationsFor(alice).find((c) => c.user_id === bob)).toBeUndefined();
  });

  it("laisse la conversation intacte pour l'autre", () => {
    sendMessage(alice, bob, "salut");
    sendMessage(bob, alice, "salut à toi");

    masquerConversation(alice, bob);

    // Le point entier de la fonctionnalité : Bob n'a rien supprimé, il doit
    // toujours voir les deux messages.
    expect(listConversation(bob, alice)).toHaveLength(2);
    expect(listConversationsFor(bob).find((c) => c.user_id === alice)).toBeDefined();
  });

  it("fait réapparaître la conversation si l'autre réécrit", () => {
    sendMessage(alice, bob, "salut");
    masquerConversation(alice, bob);
    sendMessage(bob, alice, "tu es là ?");

    const fil = listConversation(alice, bob);
    expect(fil).toHaveLength(1);
    expect(fil[0].body).toBe("tu es là ?");
    // L'historique masqué ne revient pas avec le nouveau message.
    expect(fil.some((m) => m.body === "salut")).toBe(false);
  });

  it("ne laisse pas de messages en attente derrière elle", () => {
    sendMessage(bob, alice, "un");
    sendMessage(bob, alice, "deux");
    expect(countUnreadMessages(alice)).toBe(2);

    masquerConversation(alice, bob);

    // Sinon la pastille compterait éternellement des messages devenus
    // invisibles, sans aucun moyen de la faire retomber.
    expect(countUnreadMessages(alice)).toBe(0);
  });
});

describe("remise en non-lu", () => {
  it("remet le dernier message reçu en attente", () => {
    sendMessage(bob, alice, "à lire plus tard");
    markConversationRead(alice, bob);
    expect(countUnreadMessages(alice)).toBe(0);

    expect(marquerConversationNonLue(alice, bob)).toBe(true);
    expect(countUnreadMessages(alice)).toBe(1);
  });

  it("ne fait rien quand on n'a rien reçu", () => {
    sendMessage(alice, bob, "je parle seul");
    // Remettre en attente ses propres messages n'aurait aucun sens : la
    // pastille compte ce qu'on a reçu.
    expect(marquerConversationNonLue(alice, bob)).toBe(false);
    expect(countUnreadMessages(alice)).toBe(0);
  });

  it("ignore un message masqué par une suppression", () => {
    sendMessage(bob, alice, "vieux message");
    masquerConversation(alice, bob);
    expect(marquerConversationNonLue(alice, bob)).toBe(false);
  });
});

describe("suppression d'un message", () => {
  it("supprime le sien", () => {
    const id = sendMessage(alice, bob, "erreur de frappe");
    expect(supprimerMessage(alice, id)).toBe(true);
    expect(listConversation(alice, bob)).toHaveLength(0);
  });

  it("refuse celui d'un autre, même en connaissant son identifiant", () => {
    const id = sendMessage(bob, alice, "message de Bob");
    expect(supprimerMessage(alice, id)).toBe(false);
    expect(listConversation(bob, alice)).toHaveLength(1);
  });

  it("ne touche pas au salon général", () => {
    const id = sendMessage(alice, null, "message public");
    expect(supprimerMessage(alice, id)).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = ?").get(id).n).toBe(1);
  });
});

describe("liste des conversations", () => {
  it("porte l'état de lecture du dernier message envoyé", () => {
    sendMessage(alice, bob, "tu as vu ?");
    const avant = listConversationsFor(alice).find((c) => c.user_id === bob);
    expect(avant.last_read_at).toBeNull();

    markConversationRead(bob, alice);

    // C'est ce qui permet d'afficher « Vu » sous son propre message plutôt
    // que de laisser l'expéditeur dans le doute.
    const apres = listConversationsFor(alice).find((c) => c.user_id === bob);
    expect(apres.last_read_at).not.toBeNull();
  });
});
