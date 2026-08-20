// Vérifie les outils de modération : suppression de contenu, signalements,
// suspension, rôles, épinglage et journal.
const {
  db, createUser, updateProfile, addComment, listComments, sendMessage,
  submitCommunityDeal, listCommunityDeals, createForumThread, addForumReply,
  getForumCategoryBySlug, listForumReplies,
  lireContenu, supprimerContenu, signalerContenu, listReports, countOpenReports,
  rejeterSignalement, suspendreMembre, suspensionEnCours, definirRole,
  epinglerDeal, listModerationLog, TYPES_CONTENU,
} = require("./src/db");

let echecs = 0;
const verifie = (l, c) => { console.log(c ? `✅ ${l}` : `❌ ÉCHEC — ${l}`); if (!c) echecs++; };

const admin = createUser("admin@t.fr", "x");
const membre = createUser("membre@t.fr", "x");
const gene = createUser("gene@t.fr", "x");
updateProfile(admin.id, { pseudo: "Patron" });
updateProfile(membre.id, { pseudo: "Membre" });
updateProfile(gene.id, { pseudo: "Genant" });
definirRole(admin.id, admin.id, "admin"); // refusé (soi-même) : on force en base
db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);

console.log("── Les cinq natures de contenu sont couvertes ──");
verifie("5 types déclarés", TYPES_CONTENU.length === 5);
addComment("ps5", gene.id, "Contenu douteux sous un deal");
const idComment = listComments("ps5")[0].id;
const idMessage = sendMessage(gene.id, null, "Message douteux dans le salon");
const deal = submitCommunityDeal(gene.id, { title: "Deal douteux", category: "tout" });
const cat = getForumCategoryBySlug("bons-plans");
const sujet = createForumThread(cat.id, gene.id, "Sujet douteux", "Corps du sujet");
addForumReply(sujet.id, gene.id, "Réponse douteuse");
const idReply = listForumReplies(sujet.id)[0].id;

const cibles = [["comment", idComment], ["message", idMessage], ["deal", deal.id], ["thread", sujet.id], ["reply", idReply]];
for (const [type, id] of cibles) {
  const c = lireContenu(type, id);
  verifie(`Contenu « ${type} » lisible avec son auteur`, c && c.auteurId === gene.id && c.extrait.length > 0);
}
verifie("Type inconnu refusé", lireContenu("inconnu", 1) === null);
verifie("Identifiant inexistant refusé", lireContenu("comment", 99999) === null);

console.log("\n── Signalements ──");
verifie("Signalement enregistré", signalerContenu(membre.id, "comment", idComment, "spam").ok === true);
verifie("On ne signale pas son propre contenu", signalerContenu(gene.id, "comment", idComment, "spam").ok === false);
verifie("Contenu inexistant refusé", signalerContenu(membre.id, "comment", 99999, "spam").ok === false);
const doublon = signalerContenu(membre.id, "comment", idComment, "arnaque");
verifie("Deuxième signalement du même contenu accepté sans doublon", doublon.ok === true && doublon.deja === true);
verifie("1 signalement ouvert", countOpenReports() === 1);

signalerContenu(membre.id, "deal", deal.id, "arnaque", "Le lien renvoie ailleurs");
verifie("2 signalements ouverts", countOpenReports() === 2);
const file = listReports("ouvert");
verifie("La file joint le contenu visé", file.every((r) => r.contenu && r.contenu.auteur === "Genant"));
verifie("La file joint le signalant", file.every((r) => r.signale_par === "Membre"));

console.log("\n── Rejet d'un signalement ──");
const idSignalementDeal = file.find((r) => r.content_type === "deal").id;
verifie("Rejet accepté", rejeterSignalement(admin.id, idSignalementDeal) === true);
verifie("Un signalement déjà traité n'est pas rejeté deux fois", rejeterSignalement(admin.id, idSignalementDeal) === false);
verifie("Plus qu'un signalement ouvert", countOpenReports() === 1);
verifie("Le deal n'a PAS été supprimé", listCommunityDeals("tout").length === 1);

console.log("\n── Suppression de contenu ──");
const supp = supprimerContenu(admin.id, "comment", idComment, "spam manifeste");
verifie("Suppression réussie", supp.ok === true);
verifie("Le commentaire a disparu", listComments("ps5").length === 0);
verifie("Le signalement associé est classé", countOpenReports() === 0);
verifie("Supprimer deux fois échoue proprement", supprimerContenu(admin.id, "comment", idComment).ok === false);
verifie("Type inconnu refusé", supprimerContenu(admin.id, "inconnu", 1).ok === false);
verifie("Suppression d'un deal", supprimerContenu(admin.id, "deal", deal.id).ok === true);
verifie("Le deal a disparu", listCommunityDeals("tout").length === 0);

console.log("\n── Suspension ──");
verifie("Aucune suspension au départ", suspensionEnCours(gene.id) === null);
verifie("Suspension acceptée", suspendreMembre(admin.id, gene.id, 7, "spam répété").ok === true);
const susp = suspensionEnCours(gene.id);
console.log(`  suspendu jusqu'au ${susp?.jusquA}`);
verifie("Suspension en cours détectée", susp !== null && susp.motif === "spam répété");
verifie("Un administrateur ne peut pas être suspendu", suspendreMembre(admin.id, admin.id, 7).ok === false);
verifie("Membre inexistant refusé", suspendreMembre(admin.id, 99999, 7).ok === false);
verifie("Levée de suspension", suspendreMembre(admin.id, gene.id, 0).ok === true);
verifie("Plus de suspension en cours", suspensionEnCours(gene.id) === null);
// Une suspension expirée ne doit plus rien bloquer.
db.prepare("UPDATE users SET suspended_until = ? WHERE id = ?")
  .run(new Date(Date.now() - 86400000).toISOString().slice(0, 19).replace("T", " "), gene.id);
verifie("Une suspension expirée est ignorée", suspensionEnCours(gene.id) === null);

console.log("\n── Rôles ──");
verifie("Nomination d'un modérateur", definirRole(admin.id, membre.id, "moderator").ok === true);
verifie("Le rôle est bien enregistré", db.prepare("SELECT role FROM users WHERE id = ?").get(membre.id).role === "moderator");
verifie("Rôle inconnu refusé", definirRole(admin.id, membre.id, "roi").ok === false);
verifie("On ne change pas son propre rôle", definirRole(admin.id, admin.id, "user").ok === false);
verifie("Membre inexistant refusé", definirRole(admin.id, 99999, "moderator").ok === false);

console.log("\n── Épinglage ──");
const deal2 = submitCommunityDeal(membre.id, { title: "Bon deal à épingler", category: "tout" });
verifie("Épinglage accepté", epinglerDeal(admin.id, deal2.id, true).ok === true);
verifie("La date d'épinglage est posée", listCommunityDeals("tout").find((d) => d.id === deal2.id).pinned_at !== null);
verifie("Désépinglage", epinglerDeal(admin.id, deal2.id, false).ok === true);
verifie("La date est retirée", listCommunityDeals("tout").find((d) => d.id === deal2.id).pinned_at === null);
verifie("Deal inexistant refusé", epinglerDeal(admin.id, 99999, true).ok === false);

console.log("\n── Journal de modération ──");
const journal = listModerationLog();
for (const l of journal.slice(0, 5)) console.log(`  ${l.action}${l.cible_nom ? " → " + l.cible_nom : ""}`);
verifie("Chaque action a laissé une trace", journal.length >= 8);
verifie("Le journal nomme l'administrateur", journal.every((l) => l.admin_nom));
verifie("Du plus récent au plus ancien", journal.every((l, i) => i === 0 || journal[i - 1].id > l.id));
verifie("La suppression est consignée avec un extrait",
  journal.some((l) => l.action === "suppression" && (l.detail || "").includes("spam manifeste")));
verifie("La suspension est consignée avec sa durée",
  journal.some((l) => l.action === "suspension" && (l.detail || "").includes("7 jour")));

console.log(`\n${echecs === 0 ? "Tous les tests passent." : echecs + " test(s) en échec."}`);
db.close();
process.exit(echecs === 0 ? 0 : 1);
