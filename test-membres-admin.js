// Vérifie les outils d'administration des membres : recherche, filtres,
// tri, fiche complète, courbes d'activité et exports.
const {
  db, createUser, updateProfile, submitCommunityDeal, addComment, sendMessage,
  createForumThread, getForumCategoryBySlug, signalerContenu, listComments,
  suspendreMembre, definirRole, listUsersAdmin, userAdminSheet,
  seriesQuotidiennes, membresActifs, exportMembres, exportDeals,
} = require("./src/db");

let echecs = 0;
const verifie = (l, c) => { console.log(c ? `✅ ${l}` : `❌ ÉCHEC — ${l}`); if (!c) echecs++; };
const noms = (opts) => listUsersAdmin(opts).map((u) => u.pseudo || u.email);

const admin = createUser("patron@radarprix.fr", "x");
const actif = createUser("actif@t.fr", "x");
const calme = createUser("calme@t.fr", "x");
const gene = createUser("gene@t.fr", "x");
updateProfile(admin.id, { pseudo: "Patron" });
updateProfile(actif.id, { pseudo: "Bavard" });
updateProfile(calme.id, { pseudo: "Discret" });
updateProfile(gene.id, { pseudo: "Genant" });
db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);

// Bavard publie beaucoup, Genant publie un contenu signalé, Discret rien.
for (let i = 0; i < 4; i++) submitCommunityDeal(actif.id, { title: `Deal ${i}`, category: "tout" });
for (let i = 0; i < 3; i++) addComment("ps5", actif.id, `Commentaire ${i}`);
sendMessage(actif.id, null, "Salut le salon");
createForumThread(getForumCategoryBySlug("bons-plans").id, actif.id, "Un sujet", "Corps");
addComment("ps5", gene.id, "Contenu problématique");
const idGenant = listComments("ps5").find((c) => c.body === "Contenu problématique").id;
signalerContenu(calme.id, "comment", idGenant, "spam");

console.log("── Compteurs par membre ──");
const bavard = listUsersAdmin({}).find((u) => u.pseudo === "Bavard");
console.log(`  Bavard : ${bavard.deals} deals, ${bavard.commentaires} commentaires, ${bavard.forum} forum, activité ${bavard.activite}`);
verifie("Deals comptés", bavard.deals === 4);
verifie("Commentaires comptés", bavard.commentaires === 3);
verifie("Forum compté", bavard.forum === 1);
verifie("Activité = somme de tout", bavard.activite === 4 + 3 + 1 + 1);
verifie("Discret n'a aucune activité", listUsersAdmin({}).find((u) => u.pseudo === "Discret").activite === 0);
verifie("Genant a 1 signalement ouvert", listUsersAdmin({}).find((u) => u.pseudo === "Genant").signalements === 1);
verifie("Bavard n'est pas signalé", bavard.signalements === 0);

console.log("\n── Recherche ──");
verifie("Par pseudo", noms({ recherche: "bavard" }).length === 1);
verifie("Casse ignorée", noms({ recherche: "BAVARD" }).length === 1);
verifie("Par email", noms({ recherche: "radarprix.fr" })[0] === "Patron");
verifie("Fragment d'email", noms({ recherche: "@t.fr" }).length === 3);
verifie("Recherche infructueuse", noms({ recherche: "personne" }).length === 0);
verifie("Recherche vide = tout le monde", noms({ recherche: "" }).length === 4);

console.log("\n── Tri ──");
verifie("Le plus actif en tête", noms({ tri: "actif" })[0] === "Bavard");
verifie("Le plus signalé en tête", noms({ tri: "signale" })[0] === "Genant");
verifie("Ordre alphabétique", noms({ tri: "alpha" })[0] === "Bavard");
verifie("Du plus ancien", noms({ tri: "ancien" })[0] === "Patron");
verifie("Du plus récent", noms({ tri: "recent" })[0] === "Genant");
verifie("Tri inconnu : repli sur le plus récent", noms({ tri: "n_importe_quoi" })[0] === "Genant");

console.log("\n── Filtres ──");
suspendreMembre(admin.id, gene.id, 5, "spam");
definirRole(admin.id, calme.id, "moderator");
verifie("Tous", noms({ filtre: "tous" }).length === 4);
verifie("Suspendus", noms({ filtre: "suspendus" }).length === 1 && noms({ filtre: "suspendus" })[0] === "Genant");
verifie("Équipe (admin + modérateur)", noms({ filtre: "equipe" }).sort().join(",") === "Discret,Patron");
verifie("Signalés", noms({ filtre: "signales" })[0] === "Genant");
verifie("Inactifs", noms({ filtre: "inactifs" }).includes("Discret"));
verifie("Filtre inconnu : repli sur tous", noms({ filtre: "inventé" }).length === 4);
// Une suspension expirée ne doit plus faire apparaître le membre dans le filtre.
db.prepare("UPDATE users SET suspended_until = datetime('now','-1 day') WHERE id = ?").run(gene.id);
verifie("Une suspension expirée sort du filtre", noms({ filtre: "suspendus" }).length === 0);

console.log("\n── Pagination ──");
verifie("Première page de 2", listUsersAdmin({ limit: 2, offset: 0 }).length === 2);
verifie("Deuxième page de 2", listUsersAdmin({ limit: 2, offset: 2 }).length === 2);
verifie("Au-delà, plus rien", listUsersAdmin({ limit: 2, offset: 10 }).length === 0);

console.log("\n── Fiche membre ──");
const fiche = userAdminSheet(actif.id);
verifie("La fiche existe", fiche !== null);
verifie("Elle porte les chiffres du membre", fiche.stats.deals.publies === 4);
verifie("Elle liste son activité récente", fiche.activite.length === 8); // le salon n'est pas de l'activité de profil
verifie("Membre inexistant", userAdminSheet(99999) === null);
const ficheGenant = userAdminSheet(gene.id);
verifie("Les sanctions du membre sont jointes", ficheGenant.sanctions.some((s) => s.action === "suspension"));
verifie("Le nom de l'administrateur est joint", ficheGenant.sanctions[0].admin_nom === "Patron");
verifie("Les signalements déposés sont comptés", userAdminSheet(calme.id).signalementsDeposes === 1);

console.log("\n── Courbes d'activité ──");
const series = seriesQuotidiennes(30);
verifie("30 jours, sans trou", series.length === 30);
verifie("Les jours vides valent zéro", series.slice(0, 25).every((j) => j.inscriptions === 0));
verifie("Chronologique croissant", series.every((j, i) => i === 0 || series[i - 1].jour < j.jour));
const today = series[series.length - 1];
console.log(`  aujourd'hui : ${today.inscriptions} inscription(s), ${today.deals} deal(s), ${today.forum} forum`);
verifie("Les inscriptions du jour sont comptées", today.inscriptions === 4);
verifie("Les deals du jour aussi", today.deals === 4);
verifie("Le forum additionne sujets et réponses", today.forum === 1);
verifie("2 membres actifs sur 30 jours", membresActifs(30) === 2); // Discret n'a rien publié
verifie("Une fenêtre plus courte est acceptée", seriesQuotidiennes(7).length === 7);

console.log("\n── Exports ──");
const membres = exportMembres();
verifie("Tous les membres exportés", membres.length === 4);
verifie("L'export porte les compteurs", membres.find((m) => m.pseudo === "Bavard").deals === 4);
verifie("L'export ne contient pas le mot de passe", !("password_hash" in membres[0]));
const deals = exportDeals();
verifie("Tous les deals exportés", deals.length === 4);
verifie("L'auteur est joint", deals[0].auteur === "Bavard");
verifie("Les votes sont comptés", "votes_pour" in deals[0] && "votes_contre" in deals[0]);

console.log(`\n${echecs === 0 ? "Tous les tests passent." : echecs + " test(s) en échec."}`);
db.close();
process.exit(echecs === 0 ? 0 : 1);
