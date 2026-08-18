// Vérifie l'agrégation de fiabilité par marchand à partir des votes
// communautaires : insensible à la casse/aux espaces, ratio correct,
// et "non évalué" (pas 0 fabriqué) pour un marchand jamais mentionné.
process.env.SERPAPI_KEY = "fake";
process.env.JWT_SECRET = "test-secret";

const { createUser, submitCommunityDeal, voteCommunityDeal, merchantReliability } = require("./src/db");

console.log("── Agrégation sur plusieurs deals, insensible casse/espaces ──");
const u1 = createUser("a@a.com", "hash1");
const u2 = createUser("b@b.com", "hash2");
const u3 = createUser("c@c.com", "hash3");

const d1 = submitCommunityDeal(u1.id, { title: "PS5 pas cher", seller: "Amazon " });
const d2 = submitCommunityDeal(u2.id, { title: "iPhone promo", seller: " amazon" }); // même marchand, casse/espaces différents
voteCommunityDeal(d1.id, u2.id, 1);
voteCommunityDeal(d1.id, u3.id, 1);
voteCommunityDeal(d2.id, u1.id, -1);

const amazon = merchantReliability("Amazon");
console.log(`  Amazon : ${amazon.dealCount} deals, ${amazon.upvotes} pour / ${amazon.downvotes} contre → ${amazon.reliability}%`);
console.log(
  amazon.dealCount === 2 && amazon.upvotes === 2 && amazon.downvotes === 1 && amazon.reliability === 67
    ? "✅ Agrégation correcte, insensible à la casse et aux espaces\n"
    : "❌ ÉCHEC\n"
);

console.log("── Marchand jamais mentionné : pas de score fabriqué ──");
const unknown = merchantReliability("Marchand Jamais Vu");
console.log(`  dealCount=${unknown.dealCount}, reliability=${unknown.reliability}`);
console.log(
  unknown.dealCount === 0 && unknown.reliability === null
    ? "✅ Aucun score fabriqué pour un marchand sans données\n"
    : "❌ ÉCHEC\n"
);

console.log("── Deal sans marchand renseigné : n'entre dans aucune agrégation ──");
submitCommunityDeal(u1.id, { title: "Deal sans marchand précisé" }); // pas de seller
const stillTwo = merchantReliability("Amazon");
console.log(`  Amazon toujours à ${stillTwo.dealCount} deals malgré le nouveau deal sans marchand`);
console.log(stillTwo.dealCount === 2 ? "✅ Deal sans marchand ignoré, pas rattaché par erreur\n" : "❌ ÉCHEC\n");

console.log("Tests terminés.");
