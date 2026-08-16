// catalog.js — Vrais noms de produits par catégorie, scannés en tâche
// de fond (cron.js) pour construire un vrai pool de "deals du moment"
// que le site sert ensuite instantanément, sans appel SerpApi à la volée.
const CATALOG = {
  hightech: [
    "iPhone 15 128 Go",
    "Samsung Galaxy S24",
    "MacBook Air M2",
    "Casque Sony WH-1000XM5",
    "Écouteurs AirPods Pro",
    "iPad 10e génération",
    "Xiaomi Redmi Note 13",
    "Enceinte JBL Flip 6",
    "Montre Apple Watch SE",
    "Disque dur externe 2 To",
  ],
  gaming: [
    "PlayStation 5 Slim",
    "Xbox Series X",
    "Nintendo Switch 2",
    "Carte graphique RTX 4060",
    "PC portable gamer RTX 4060",
    "Manette DualSense PS5",
    "Casque gaming HyperX",
    "Écran gamer 144Hz",
    "SSD NVMe 1To",
  ],
  maison: [
    "Aspirateur robot Roborock",
    "Dyson V15",
    "Lave-linge Bosch",
    "Friteuse sans huile Philips",
    "Cafetière Nespresso",
    "Purificateur d'air Xiaomi",
    "Micro-ondes Samsung",
    "Réfrigérateur combiné",
  ],
  mode: [
    "Nike Air Max 90",
    "Adidas Samba",
    "Doudoune The North Face",
    "Sac à dos Eastpak",
    "Baskets New Balance 574",
    "Jean Levi's 501",
  ],
  beaute: [
    "Sèche-cheveux Dyson Supersonic",
    "Épilateur Braun",
    "Brosse à dents électrique Oral-B",
    "Parfum Chanel",
  ],
  alimentaire: [
    "Nespresso Vertuo capsules",
    "Thermomix TM6",
    "Cafetière Delonghi",
    "Machine à pain",
  ],
  sport: [
    "Montre connectée Garmin",
    "Vélo elliptique",
    "Tapis de course",
    "Vélo électrique",
  ],
  auto: [
    "Dashcam Nextbase",
    "Siège auto bébé",
    "Chargeur voiture rapide",
    "GPS voiture Garmin",
  ],
};

/** Renvoie tous les produits (nom + catégorie), à plat, pour le cron. */
function allProducts() {
  return Object.entries(CATALOG).flatMap(([category, names]) =>
    names.map((name) => ({ name, category }))
  );
}

/** Renvoie un nom de produit au hasard pour une catégorie donnée (recherche libre / repli). */
function randomProductFor(categoryId) {
  const pool =
    categoryId && CATALOG[categoryId] ? CATALOG[categoryId] : Object.values(CATALOG).flat();
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { CATALOG, allProducts, randomProductFor };
