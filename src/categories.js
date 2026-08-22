// categories.js — Les rubriques des sources, ramenées aux nôtres.
//
// Cette table vivait en double, dans le lecteur de flux et dans celui des
// pages Pepper. Les deux copies ont divergé et l'une portait un défaut que
// l'autre n'avait pas : « son » sans délimiteur y attrapait « Maison » et
// « Boissons », qui atterrissaient donc en high-tech. Une seule table, un
// seul endroit à corriger.
//
// Les motifs sont ancrés sur des mots entiers. Les rubriques d'un site de
// bons plans sont des libellés courts et bruyants — « Image & Son »,
// « Maison & Habitat » — où une sous-chaîne isolée se trompe vite.

const REGLES = [
  [/\b(?:high[-\s]?tech|informatique|t[ée]l[ée]phonie|smartphone|ordinateur|image\s*&?\s*son|photo|hifi)\b/i, "hightech"],
  [/\b(?:consoles?|jeux?\s*vid[ée]o|gaming|jeu\s*pc)\b/i, "gaming"],
  [/\b(?:maison|habitat|jardin|jardinage|bricolage|[ée]lectrom[ée]nager|meubles?|d[ée]coration|d[ée]co)\b/i, "maison"],
  [/\b(?:mode|accessoires?|v[êe]tements?|chaussures?|bijoux?|montres?|textile)\b/i, "mode"],
  [/\b(?:beaut[ée]|hygi[èe]ne|parfums?|sant[ée]|cosm[ée]tiques?|soins?)\b/i, "beaute"],
  [/\b(?:courses?|alimentation|alimentaire|boissons?|[ée]picerie|caf[ée]|gastronomie)\b/i, "alimentaire"],
  [/\b(?:sports?|plein\s*air|fitness|v[ée]los?|randonn[ée]e|outdoor)\b/i, "sport"],
  [/\b(?:auto|automobile|moto|v[ée]hicules?|pneus?|garage)\b/i, "auto"],
];

/**
 * Catégorie RadarPrix d'après un ou plusieurs libellés de source.
 * Rend null quand rien ne correspond — l'appelant décide du repli.
 */
function categorieDepuisLibelle(libelles) {
  const texte = [].concat(libelles || []).filter(Boolean).join(" ");
  for (const [motif, categorie] of REGLES) {
    if (motif.test(texte)) return categorie;
  }
  return null;
}

module.exports = { categorieDepuisLibelle };
