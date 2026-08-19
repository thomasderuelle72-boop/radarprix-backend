// Vérifie les garde-fous appliqués à tout ce qu'un membre publie.
// Le formulaire limitait déjà la longueur côté navigateur, mais rien
// n'empêchait d'appeler l'API directement : ces règles-là, elles, tiennent.
const { validerTexte, limiterFrequence, refuserDoublon } = require("./src/moderation");

let echecs = 0;
function verifie(libelle, condition) {
  console.log(condition ? `✅ ${libelle}` : `❌ ÉCHEC — ${libelle}`);
  if (!condition) echecs++;
}

console.log("── Longueur ──");
verifie("Texte vide refusé", validerTexte("   ", "comment").ok === false);
verifie("Texte trop court refusé", validerTexte("a", "comment").ok === false);
verifie("Commentaire normal accepté", validerTexte("Super deal, merci !", "comment").ok === true);
verifie("Pavé de 3000 caractères refusé sur un commentaire", validerTexte("a".repeat(3000), "comment").ok === false);
verifie("3000 caractères acceptés sur un sujet de forum", validerTexte("Bonjour ".repeat(300), "thread").ok === true);

console.log("\n── Espaces superflus retirés ──");
const nettoye = validerTexte("   Bon plan !   ", "comment");
console.log(`  "${nettoye.value}"`);
verifie("Texte nettoyé de ses espaces", nettoye.value === "Bon plan !");

console.log("\n── Spam ──");
verifie(
  "Mur de liens refusé",
  validerTexte("http://a.fr http://b.fr http://c.fr http://d.fr http://e.fr", "comment").ok === false
);
verifie(
  "Un lien dans un vrai message reste accepté",
  validerTexte("Je l'ai vu ici aussi : https://exemple.fr/produit", "comment").ok === true
);
verifie("Texte tout en majuscules refusé", validerTexte("ACHETEZ MAINTENANT CE PRODUIT INCROYABLE", "comment").ok === false);
verifie("Sigle en majuscules dans un texte normal accepté", validerTexte("La PS5 est dispo à la FNAC", "comment").ok === true);
verifie("Caractères répétés en boucle refusés", validerTexte("aaaaaaaaaaaaaaaaaaaaaa", "comment").ok === false);

console.log("\n── Limitation de fréquence ──");
const u = 4242;
let bloqueAu = null;
for (let i = 1; i <= 7; i++) {
  const r = limiterFrequence(u, "comment", 5, 60000);
  if (!r.ok && bloqueAu === null) bloqueAu = i;
}
console.log(`  bloqué à la tentative n°${bloqueAu}`);
verifie("Bloque après 5 publications par minute", bloqueAu === 6);
verifie("Un autre membre n'est pas affecté", limiterFrequence(9999, "comment", 5, 60000).ok === true);
verifie("Une autre action n'est pas affectée", limiterFrequence(u, "reply", 5, 60000).ok === true);

console.log("\n── Doublon ──");
verifie("Premier envoi accepté", refuserDoublon(7, "Merci pour l'info").ok === true);
verifie("Même message aussitôt refusé", refuserDoublon(7, "Merci pour l'info").ok === false);
verifie("Message différent accepté", refuserDoublon(7, "Une autre remarque").ok === true);

console.log(`\n${echecs === 0 ? "Tous les tests passent." : echecs + " test(s) en échec."}`);
process.exit(echecs === 0 ? 0 : 1);
