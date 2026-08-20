// Vérifie la messagerie : historique du salon, suivi de lecture des messages
// privés, et décompte des messages en attente.
const {
  db, createUser, updateProfile, sendMessage, listPublicMessages,
  listConversation, listConversationsFor, markConversationRead, countUnreadMessages,
} = require("./src/db");

let echecs = 0;
function verifie(libelle, condition) {
  console.log(condition ? `✅ ${libelle}` : `❌ ÉCHEC — ${libelle}`);
  if (!condition) echecs++;
}

const alice = createUser("alice@t.fr", "x");
const bob = createUser("bob@t.fr", "x");
const carol = createUser("carol@t.fr", "x");
updateProfile(alice.id, { pseudo: "Alice", avatarUrl: "https://exemple.fr/a.jpg" });
updateProfile(bob.id, { pseudo: "Bob" });
updateProfile(carol.id, { pseudo: "Carol" });

console.log("── Salon général ──");
// 250 messages : bien au-delà de la fenêtre de 100 renvoyée par l'API.
for (let i = 1; i <= 250; i++) sendMessage(i % 2 ? alice.id : bob.id, null, `Message ${i}`);

const premiere = listPublicMessages(0, 100);
console.log(`  premier chargement : ${premiere[0].body} … ${premiere[premiere.length - 1].body}`);
verifie("100 messages renvoyés", premiere.length === 100);
verifie("Ce sont les 100 DERNIERS, pas les premiers", premiere[0].body === "Message 151");
verifie("Le plus récent ferme la liste", premiere[premiere.length - 1].body === "Message 250");
verifie("Ordre chronologique croissant", premiere.every((m, i) => i === 0 || premiere[i - 1].id < m.id));
verifie("La photo de l'auteur est jointe", premiere.find((m) => m.author === "Alice").avatar_url === "https://exemple.fr/a.jpg");

const suite = listPublicMessages(premiere[premiere.length - 1].id, 100);
verifie("Aucun nouveau message après le dernier", suite.length === 0);
sendMessage(carol.id, null, "Message 251");
const apres = listPublicMessages(premiere[premiere.length - 1].id, 100);
verifie("Le sondage ne renvoie que la nouveauté", apres.length === 1 && apres[0].body === "Message 251");

console.log("\n── Messages privés ──");
sendMessage(bob.id, alice.id, "Salut Alice, ce deal est encore valable ?");
sendMessage(bob.id, alice.id, "Je viens de voir ton post.");
sendMessage(alice.id, bob.id, "Oui, toujours dispo !");
sendMessage(carol.id, alice.id, "Bonjour !");

const fil = listConversation(alice.id, bob.id);
verifie("3 messages dans le fil Alice/Bob", fil.length === 3);
verifie("Ordre chronologique", fil[0].body.startsWith("Salut Alice"));
verifie("La photo de l'auteur est jointe au fil", "avatar_url" in fil[0]);
verifie("Le fil ne contient pas la conversation avec Carol", !fil.some((m) => m.body === "Bonjour !"));

console.log("\n── Messages en attente ──");
verifie("Alice a 3 messages en attente", countUnreadMessages(alice.id) === 3);
verifie("Bob a 1 message en attente", countUnreadMessages(bob.id) === 1);
verifie("Carol n'a rien en attente", countUnreadMessages(carol.id) === 0);

const convos = listConversationsFor(alice.id);
console.log(`  ${convos.map((c) => `${c.display_name} (${c.non_lus})`).join(", ")}`);
verifie("2 conversations pour Alice", convos.length === 2);
verifie("Le dernier message de chaque fil est joint", convos.every((c) => c.last_body));
verifie("Les non-lus sont comptés par conversation",
  convos.find((c) => c.display_name === "Bob").non_lus === 2);
verifie("Carol : 1 non-lu", convos.find((c) => c.display_name === "Carol").non_lus === 1);
verifie("La conversation la plus récente est en tête", convos[0].display_name === "Carol");

console.log("\n── Ouverture d'un fil = lecture ──");
verifie("2 messages marqués lus", markConversationRead(alice.id, bob.id) === 2);
verifie("Alice n'a plus qu'un message en attente", countUnreadMessages(alice.id) === 1);
verifie("La conversation Bob passe à 0 non-lu",
  listConversationsFor(alice.id).find((c) => c.display_name === "Bob").non_lus === 0);
verifie("Relire ne marque rien de plus", markConversationRead(alice.id, bob.id) === 0);
verifie("Ses propres messages ne sont jamais comptés", countUnreadMessages(bob.id) === 1);

sendMessage(bob.id, alice.id, "Autre chose…");
verifie("Un nouveau message redevient en attente",
  listConversationsFor(alice.id).find((c) => c.display_name === "Bob").non_lus === 1);

console.log(`\n${echecs === 0 ? "Tous les tests passent." : echecs + " test(s) en échec."}`);
db.close();
process.exit(echecs === 0 ? 0 : 1);
