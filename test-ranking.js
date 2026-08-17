// test-ranking.js — vérifie l'indicateur de classement des deals communautaires.
// Exécution : node test-ranking.js (aucune dépendance, aucune base de données).
const { hotScore, sortByHotScore } = require("./src/ranking");

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) {
    console.log(`✅ ${label}`);
    passed++;
  } else {
    console.log(`❌ ${label}`);
    failed++;
  }
}

const NOW = new Date("2026-08-17T12:00:00Z");
const sqlNow = "2026-08-17 12:00:00";
const sqlOneHourAgo = "2026-08-17 11:00:00";
const sqlOneDayAgo = "2026-08-16 12:00:00";
const sqlOneWeekAgo = "2026-08-10 12:00:00";

// Plus de votes positifs (à ancienneté égale) => score plus élevé.
check(
  "plus de votes pertinents => score plus haut (même âge)",
  hotScore(20, 0, sqlOneHourAgo, NOW) > hotScore(5, 0, sqlOneHourAgo, NOW)
);

// Un deal récent bat un deal ancien à votes strictement égaux.
check(
  "à votes égaux, le deal le plus récent est mieux classé",
  hotScore(10, 0, sqlOneHourAgo, NOW) > hotScore(10, 0, sqlOneWeekAgo, NOW)
);

// Les votes négatifs pénalisent le score par rapport à zéro vote.
check(
  "des votes négatifs nets font baisser le score sous un deal neutre",
  hotScore(1, 5, sqlOneHourAgo, NOW) < hotScore(0, 0, sqlOneHourAgo, NOW)
);

// Un très gros écart de votes peut compenser une grosse différence d'ancienneté.
check(
  "un très gros score de votes peut dépasser un deal récent peu voté",
  hotScore(500, 0, sqlOneWeekAgo, NOW) > hotScore(1, 0, sqlOneHourAgo, NOW)
);

// Sans aucun vote, le score ne doit jamais planter (log(0) etc.) et doit décroître avec l'âge.
check(
  "0 vote reste calculable et décroît avec le temps",
  Number.isFinite(hotScore(0, 0, sqlOneDayAgo, NOW)) && hotScore(0, 0, sqlNow, NOW) > hotScore(0, 0, sqlOneDayAgo, NOW)
);

// sortByHotScore trie bien du meilleur au moins bon.
const deals = [
  { id: "vieux-peu-voté", upvotes: 2, downvotes: 0, created_at: sqlOneWeekAgo },
  { id: "récent-très-voté", upvotes: 50, downvotes: 1, created_at: sqlOneHourAgo },
  { id: "récent-mal-noté", upvotes: 0, downvotes: 8, created_at: sqlOneHourAgo },
];
const sorted = sortByHotScore(deals, NOW);
check(
  "sortByHotScore place le deal récent très voté en tête",
  sorted[0].id === "récent-très-voté"
);
check(
  "sortByHotScore place le deal mal noté en dernier",
  sorted[sorted.length - 1].id === "récent-mal-noté"
);

console.log(`\n${passed} test(s) réussi(s), ${failed} échoué(s).`);
if (failed > 0) process.exit(1);
