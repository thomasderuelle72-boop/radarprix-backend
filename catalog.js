// catalog.js — Vrais noms de produits par catégorie, utilisés quand
// l'utilisateur scanne une catégorie sans préciser de produit exact.
// Chercher un vrai nom de produit donne des résultats bien plus pertinents
// et comparables qu'une requête vague type "high-tech promo" : Google
// Shopping retourne alors plusieurs vendeurs du MÊME produit, ce qui est
// justement ce dont l'algorithme a besoin pour comparer les prix.
const CATALOG = {
  hightech: [
    "iPhone 15 128 Go",
    "Samsung Galaxy S24",
    "MacBook Air M2",
    "Casque Sony WH-1000XM5",
    "Écouteurs AirPods Pro",
    "Nintendo Switch OLED",
  ],
  gaming: [
    "PlayStation 5 Slim",
    "Xbox Series X",
    "Nintendo Switch 2",
    "Carte graphique RTX 4060",
    "PC portable gamer RTX 4060",
  ],
  maison: [
    "Aspirateur robot Roborock",
    "Dyson V15",
    "Lave-linge Bosch",
    "Friteuse sans huile Philips",
    "Cafetière Nespresso",
  ],
  mode: [
    "Nike Air Max 90",
    "Adidas Samba",
    "Doudoune The North Face",
    "Sac à dos Eastpak",
  ],
  beaute: [
    "Sèche-cheveux Dyson Supersonic",
    "Épilateur Braun",
    "Brosse à dents électrique Oral-B",
  ],
  alimentaire: [
    "Nespresso Vertuo capsules",
    "Thermomix TM6",
    "Cafetière Delonghi",
  ],
  sport: [
    "Montre connectée Garmin",
    "Vélo elliptique",
    "Tapis de course",
  ],
  auto: [
    "Dashcam Nextbase",
    "Siège auto bébé",
    "Chargeur voiture rapide",
  ],
};

/** Renvoie un nom de produit au hasard pour une catégorie donnée. */
function randomProductFor(categoryId) {
  const pool =
    categoryId && CATALOG[categoryId]
      ? CATALOG[categoryId]
      : Object.values(CATALOG).flat();
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { CATALOG, randomProductFor };
