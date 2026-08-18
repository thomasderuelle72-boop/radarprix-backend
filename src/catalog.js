// catalog.js — Vrais noms de produits par catégorie, scannés en tâche
// de fond (cron.js) pour construire un vrai pool de "deals du moment"
// que le site sert ensuite instantanément, sans appel SerpApi à la volée.
// Chaque entrée doit être un modèle précis (marque + modèle + variante
// distinctive : capacité, génération, taille…), jamais une catégorie
// vague ("Vélo électrique", "Réfrigérateur combiné") — sinon une recherche
// remonte des produits différents qui ne peuvent pas être comparés entre
// eux de façon fiable (voir clusterByProduct dans algorithm.js).
const CATALOG = {
  hightech: [
    "iPhone 15 128 Go",
    "iPhone 14 128 Go",
    "Samsung Galaxy S24",
    "Samsung Galaxy A55",
    "MacBook Air M2",
    "MacBook Pro M3 14 pouces",
    "Casque Sony WH-1000XM5",
    "Écouteurs AirPods Pro 2",
    "iPad 10e génération",
    "iPad Air M2",
    "Xiaomi Redmi Note 13",
    "Google Pixel 8",
    "Enceinte JBL Flip 6",
    "Montre Apple Watch SE",
    "Montre Samsung Galaxy Watch 6",
    "Disque SSD externe Samsung T7 2 To",
    "Kindle Paperwhite 11e génération",
  ],
  gaming: [
    "PlayStation 5 Slim",
    "PlayStation 5 Pro",
    "Xbox Series X",
    "Xbox Series S",
    "Nintendo Switch 2",
    "Nintendo Switch OLED",
    "Carte graphique RTX 4060",
    "Carte graphique RTX 4070",
    "PC portable gamer RTX 4060",
    "Manette DualSense PS5",
    "Manette Xbox Series",
    "Casque gaming HyperX Cloud II",
    "Écran gamer Samsung Odyssey G5 144Hz",
    "SSD NVMe Samsung 990 Pro 1To",
    "Clavier mécanique Logitech G Pro",
  ],
  maison: [
    "Aspirateur robot Roborock Q7 Max",
    "Aspirateur robot Roomba Combo j5+",
    "Aspirateur balai Dyson V15",
    "Lave-linge Bosch Serie 6 8kg",
    "Lave-vaisselle Bosch Serie 4",
    "Friteuse sans huile Philips Airfryer XXL",
    "Cafetière Nespresso Vertuo Next",
    "Purificateur d'air Xiaomi Smart Air Purifier 4",
    "Micro-ondes Samsung MS23K3513AS",
    "Réfrigérateur combiné Samsung RB34",
    "Climatiseur mobile De'Longhi Pinguino",
    "Aspirateur sans fil Dyson V8",
  ],
  mode: [
    "Nike Air Max 90",
    "Nike Air Force 1",
    "Adidas Samba OG",
    "Adidas Gazelle",
    "Doudoune The North Face Nuptse",
    "Sac à dos Eastpak Padded Pak'r",
    "Baskets New Balance 574",
    "Baskets New Balance 530",
    "Jean Levi's 501",
    "Montre Casio G-Shock",
  ],
  beaute: [
    "Sèche-cheveux Dyson Supersonic",
    "Épilateur Braun Silk-épil 9",
    "Brosse à dents électrique Oral-B iO9",
    "Lisseur GHD Platinum+",
    "Rasoir électrique Philips OneBlade",
    "Parfum Chanel Bleu de Chanel 100ml",
    "Parfum Dior Sauvage 100ml",
  ],
  alimentaire: [
    "Nespresso Vertuo Next capsules x50",
    "Thermomix TM6",
    "Cafetière De'Longhi Magnifica S",
    "Machine à pain Moulinex Pain Doré",
    "Blender Vitamix E310",
    "Cave à vin Klarstein 18 bouteilles",
  ],
  sport: [
    "Montre connectée Garmin Forerunner 265",
    "Montre connectée Garmin Fenix 7",
    "Vélo elliptique Domyos EL500",
    "Tapis de course Domyos T520B",
    "Vélo électrique Decathlon Rockrider E-EXPL 500",
    "Vélo électrique Nakamura E-Summit 740",
    "Trottinette électrique Xiaomi Electric Scooter 4",
    "Vélo d'appartement Domyos EB500",
  ],
  auto: [
    "Dashcam Nextbase 622GW",
    "Siège auto Cybex Cloud G i-Size",
    "Chargeur voiture rapide Anker 40W",
    "GPS voiture Garmin DriveSmart 65",
    "Support téléphone voiture Belkin MagSafe",
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
