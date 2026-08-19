// Vérifie les profils publics de membres : résolution par pseudo ou par id,
// chiffres d'activité, fil d'activité, abonnements, unicité des pseudos et
// calcul des badges.
const {
  db, createUser, updateProfile, findUserByHandle, publicProfile, userStats,
  userActivity, userDeals, userThreads, badgeEventDates, pseudoDejaPris,
  followUser, unfollowUser, isFollowing, listFollowing, dealsFromFollowed,
  submitCommunityDeal, voteCommunityDeal, addComment, createForumThread,
  addForumReply, getForumCategoryBySlug, deleteAccount,
} = require("./src/db");
const { calculerBadges, prochainsBadges, datesAnciennete } = require("./src/badges");

let echecs = 0;
function verifie(libelle, condition) {
  console.log(condition ? `✅ ${libelle}` : `❌ ÉCHEC — ${libelle}`);
  if (!condition) echecs++;
}

// ── Jeu d'essai ──────────────────────────────────────────────────
const alice = createUser("alice@test.fr", "x");
const bob = createUser("bob@test.fr", "x");
const carol = createUser("carol@test.fr", "x");
updateProfile(alice.id, { pseudo: "Alice" });
updateProfile(bob.id, { pseudo: "Bob" });

const deal1 = submitCommunityDeal(alice.id, { title: "Casque Sony à -60%", category: "high-tech", seller: "Amazon" });
const deal2 = submitCommunityDeal(alice.id, { title: "Machine à café soldée", category: "maison" });
voteCommunityDeal(deal1.id, bob.id, 1);
voteCommunityDeal(deal1.id, carol.id, 1);
voteCommunityDeal(deal2.id, bob.id, -1);
addComment("casque sony", alice.id, "Je l'ai pris, aucun regret.");
addComment("casque sony", bob.id, "Merci du partage !");
const cat = getForumCategoryBySlug("bons-plans");
const sujet = createForumThread(cat.id, alice.id, "Où trouver un bon four ?", "Je cherche des retours.");
addForumReply(sujet.id, bob.id, "Regarde chez Boulanger.");

console.log("── Résolution d'un membre ──");
verifie("Retrouvé par pseudo", findUserByHandle("Alice")?.id === alice.id);
verifie("Retrouvé par pseudo, casse ignorée", findUserByHandle("alICE")?.id === alice.id);
verifie("Retrouvé par identifiant numérique", findUserByHandle(String(alice.id))?.id === alice.id);
verifie("Pseudo inconnu -> rien", findUserByHandle("Personne") === undefined);

const profil = publicProfile("Alice");
console.log(`  ${profil.displayName}, inscrit le ${profil.createdAt}`);
verifie("Le profil public n'expose pas l'email", !("email" in profil));
verifie("Nom d'affichage correct", profil.displayName === "Alice");
verifie("Membre sans pseudo affiché en 'Membre #id'", publicProfile(String(carol.id)).displayName === `Membre #${carol.id}`);

console.log("\n── Unicité des pseudos ──");
verifie("Pseudo déjà pris détecté", pseudoDejaPris("Bob", carol.id) === true);
verifie("Casse et espaces ignorés", pseudoDejaPris("  bob  ", carol.id) === true);
verifie("Son propre pseudo ne se bloque pas lui-même", pseudoDejaPris("Bob", bob.id) === false);
const refus = updateProfile(carol.id, { pseudo: "Bob" });
verifie("Enregistrement d'un pseudo déjà pris refusé", refus.ok === false);
verifie("Message d'erreur explicite", /déjà utilisé/.test(refus.error || ""));
verifie("Pseudo libre accepté", updateProfile(carol.id, { pseudo: "Carol" }).ok === true);

console.log("\n── Chiffres d'activité ──");
const s = userStats(alice.id);
console.log(`  ${s.deals.publies} deals, ${s.deals.votesRecus} votes reçus, ${s.commentaires} commentaires, ${s.forum.sujets} sujets`);
verifie("2 deals publiés", s.deals.publies === 2);
verifie("2 votes positifs reçus", s.deals.votesRecus === 2);
verifie("Meilleur score net = 2", s.deals.meilleurScore === 2);
verifie("1 commentaire", s.commentaires === 1);
verifie("1 sujet de forum", s.forum.sujets === 1);
verifie("0 réponse de forum", s.forum.reponses === 0);
verifie("Aucun vote émis par Alice", s.votes.emis === 0);
verifie("2 votes émis par Bob", userStats(bob.id).votes.emis === 2);
verifie("Bob a 1 réponse de forum", userStats(bob.id).forum.reponses === 1);
verifie("Aucun abonné au départ", s.abonnes === 0);

console.log("\n── Fil d'activité ──");
const activite = userActivity(alice.id);
for (const a of activite) console.log(`  [${a.type}] ${a.titre}`);
verifie("4 évènements pour Alice", activite.length === 4);
verifie("3 types représentés : deal, commentaire, sujet", new Set(activite.map((a) => a.type)).size === 3);
verifie("Trié du plus récent au plus ancien",
  activite.every((a, i) => i === 0 || activite[i - 1].created_at >= a.created_at));
verifie("La réponse de Bob apparaît dans son fil", userActivity(bob.id).some((a) => a.type === "reply"));
verifie("Une réponse porte le titre du sujet", userActivity(bob.id).find((a) => a.type === "reply").titre === "Où trouver un bon four ?");

console.log("\n── Deals et sujets d'un membre ──");
verifie("2 deals listés pour Alice", userDeals(alice.id).length === 2);
verifie("Les votes sont comptés", userDeals(alice.id).find((d) => d.id === deal1.id).upvotes === 2);
verifie("1 sujet listé pour Alice", userThreads(alice.id).length === 1);
verifie("Le nombre de réponses est joint", userThreads(alice.id)[0].reply_count === 1);
verifie("La catégorie du sujet est jointe", userThreads(alice.id)[0].category_slug === "bons-plans");

console.log("\n── Abonnements ──");
verifie("On ne peut pas s'abonner à soi-même", followUser(alice.id, alice.id).ok === false);
verifie("Abonnement enregistré", followUser(bob.id, alice.id).ok === true);
verifie("Abonnement en double sans erreur", followUser(bob.id, alice.id).ok === true);
verifie("Alice a 1 abonné", userStats(alice.id).abonnes === 1);
verifie("Bob a 1 abonnement", userStats(bob.id).abonnements === 1);
verifie("isFollowing vrai", isFollowing(bob.id, alice.id) === true);
verifie("isFollowing faux dans l'autre sens", isFollowing(alice.id, bob.id) === false);
verifie("isFollowing faux sans être connecté", isFollowing(null, alice.id) === false);
verifie("La liste des suivis contient Alice", listFollowing(bob.id)[0].display_name === "Alice");
verifie("Le fil des suivis contient les 2 deals d'Alice", dealsFromFollowed(bob.id).length === 2);
unfollowUser(bob.id, alice.id);
verifie("Désabonnement effectif", isFollowing(bob.id, alice.id) === false);
verifie("Le fil des suivis se vide", dealsFromFollowed(bob.id).length === 0);

console.log("\n── Badges ──");
const badges = calculerBadges(badgeEventDates(alice.id));
for (const b of badges) console.log(`  ${b.nom} niveau ${b.niveau} — ${b.obtenuLe}`);
const familles = badges.map((b) => b.famille);
verifie("Badge Chasseur obtenu (1 deal publié)", familles.includes("chasseur"));
verifie("Badge Voix obtenu (1 commentaire)", familles.includes("voix"));
verifie("Badge Animateur obtenu (1 sujet)", familles.includes("animateur"));
verifie("Pas de badge Éclaireur (aucun vote émis)", !familles.includes("eclaireur"));
verifie("Pas de badge Flair (2 votes reçus < 10)", !familles.includes("populaire"));
verifie("Pas de badge Pilier (compte créé à l'instant)", !familles.includes("pilier"));
verifie("Chaque badge porte une date réelle", badges.every((b) => b.obtenuLe && !Number.isNaN(Date.parse(b.obtenuLe.replace(" ", "T") + "Z"))));
verifie("Badges triés du plus récent au plus ancien",
  badges.every((b, i) => i === 0 || badges[i - 1].obtenuLe >= b.obtenuLe));
// Carol a déjà voté plus haut : pour tester le profil vierge il faut un
// compte qui n'a strictement rien fait.
const nouveau = createUser("nouveau@test.fr", "x");
verifie("Un membre sans activité n'a aucun badge", calculerBadges(badgeEventDates(nouveau.id)).length === 0);
verifie("Un membre sans activité a quand même des objectifs", prochainsBadges(badgeEventDates(nouveau.id)).length > 0);
verifie("Carol a le badge Éclaireur pour son unique vote",
  calculerBadges(badgeEventDates(carol.id)).some((b) => b.famille === "eclaireur"));

console.log("\n── Progression vers le prochain badge ──");
const suite = prochainsBadges(badgeEventDates(alice.id));
for (const p of suite) console.log(`  ${p.nom} : ${p.actuel}/${p.objectif}`);
verifie("Une progression est proposée", suite.length > 0);
verifie("Le plus proche est en tête", suite[0].objectif - suite[0].actuel <= suite[suite.length - 1].objectif - suite[suite.length - 1].actuel);
verifie("L'ancienneté n'est pas proposée comme objectif", !suite.some((p) => p.famille === "pilier"));
verifie("La progression Chasseur part de 2 deals", suite.find((p) => p.famille === "chasseur").actuel === 2);

console.log("\n── Ancienneté ──");
const ilYaUnAn = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
verifie("3 paliers d'ancienneté après 400 jours", datesAnciennete(ilYaUnAn).length === 3);
verifie("1 seul palier après 45 jours",
  datesAnciennete(new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ")).length === 1);
verifie("Aucun palier pour un compte du jour",
  datesAnciennete(new Date().toISOString().slice(0, 19).replace("T", " ")).length === 0);
verifie("Sans date d'inscription, aucun palier", datesAnciennete(null).length === 0);

console.log("\n── Suppression de compte ──");
followUser(carol.id, alice.id);
deleteAccount(carol.id);
verifie("Le membre supprimé n'a plus de profil", publicProfile(String(carol.id)) === null);
verifie("Ses abonnements sont retirés", userStats(alice.id).abonnes === 0);
verifie("Son pseudo redevient disponible", pseudoDejaPris("Carol", alice.id) === false);

console.log(`\n${echecs === 0 ? "Tous les tests passent." : echecs + " test(s) en échec."}`);
db.close();
process.exit(echecs === 0 ? 0 : 1);
