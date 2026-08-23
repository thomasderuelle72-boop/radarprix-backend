// marchands.js — Le registre des enseignes françaises suivies par RadarPrix.
//
// Pourquoi une liste en dur plutôt qu'une table à remplir : le site doit
// fonctionner à l'installation, sans que personne ait à saisir cent
// domaines à la main. La liste est du code, donc versionnée, relue et
// testée ; l'administration peut ensuite désactiver ou compléter, mais
// n'a jamais à partir de zéro.
//
// Chaque entrée porte le minimum utile à la détection :
//
//   nom       — tel qu'il s'affiche sur une carte ;
//   domaine   — sert à reconnaître un lien et à cadrer une recherche ;
//   alias     — les autres façons dont une source écrit ce nom, pour le
//               retrouver dans le titre d'un bon plan (« Amazon.fr », « Fnac
//               Darty »). Sans ça, un flux d'agrégateur ne nomme jamais son
//               marchand et ses offres finissent sans vendeur ;
//   categorie — la catégorie RadarPrix dominante de l'enseigne ;
//   promo     — chemin public des promotions. Toutes les valeurs devinées
//               ont été retirées après mesure : sur vingt-huit pages
//               sondées, douze répondent 403 (Cloudflare, DataDome), six
//               n'existent pas, et les dix restantes chargent leurs
//               produits en JavaScript. Zéro produit extrait. Le champ
//               reste pour une adresse VÉRIFIÉE, jamais supposée.
//
// Rien ici n'est une clé d'API ni un accès privilégié : ce sont des adresses
// publiques. Ce qu'on en fait est encadré dans collect.js.

const MARCHANDS = [
  // ── Généralistes et marketplaces ──
  { nom: "Amazon", domaine: "amazon.fr", recherche: "https://www.amazon.fr/s?k={q}", alias: ["amazon"], categorie: "tout", promo: null },
  { nom: "Cdiscount", domaine: "cdiscount.com", recherche: "https://www.cdiscount.com/search/10/{q}.html", alias: ["cdiscount"], categorie: "tout", promo: null },
  { nom: "Fnac", domaine: "fnac.com", recherche: "https://www.fnac.com/SearchResult/ResultList.aspx?Search={q}", alias: ["fnac"], categorie: "hightech", promo: null },
  { nom: "Darty", domaine: "darty.com", recherche: "https://www.darty.com/nav/recherche?text={q}", alias: ["darty"], categorie: "maison", promo: null },
  { nom: "Boulanger", domaine: "boulanger.com", recherche: "https://www.boulanger.com/resultats?tr={q}", alias: ["boulanger"], categorie: "hightech", promo: null },
  { nom: "Rakuten", domaine: "rakuten.fr", recherche: "https://fr.shopping.rakuten.com/search/{q}", alias: ["rakuten", "priceminister"], categorie: "tout", promo: null },
  { nom: "E.Leclerc", domaine: "e.leclerc", alias: ["leclerc", "e leclerc"], categorie: "alimentaire", promo: null },
  { nom: "Carrefour", domaine: "carrefour.fr", recherche: "https://www.carrefour.fr/s?q={q}", alias: ["carrefour"], categorie: "alimentaire", promo: null },
  { nom: "Auchan", domaine: "auchan.fr", recherche: "https://www.auchan.fr/recherche?text={q}", alias: ["auchan"], categorie: "alimentaire", promo: null },
  { nom: "Intermarché", domaine: "intermarche.com", recherche: "https://www.intermarche.com/recherche/{q}", alias: ["intermarche", "intermarché"], categorie: "alimentaire", promo: null },
  { nom: "Casino", domaine: "casino.fr", alias: ["geant casino", "casino"], categorie: "alimentaire", promo: null },
  { nom: "Monoprix", domaine: "monoprix.fr", alias: ["monoprix"], categorie: "alimentaire", promo: null },
  { nom: "Cora", domaine: "cora.fr", alias: ["cora"], categorie: "alimentaire", promo: null },
  { nom: "Super U", domaine: "coursesu.com", alias: ["super u", "hyper u", "magasins u"], categorie: "alimentaire", promo: null },
  { nom: "Lidl", domaine: "lidl.fr", recherche: "https://www.lidl.fr/q/search?q={q}", alias: ["lidl"], categorie: "alimentaire", promo: null },
  { nom: "Aldi", domaine: "aldi.fr", alias: ["aldi"], categorie: "alimentaire", promo: null },
  { nom: "Veepee", domaine: "veepee.fr", alias: ["veepee", "vente privee", "vente-privee"], categorie: "tout", promo: null },
  { nom: "ShowroomPrivé", domaine: "showroomprive.com", alias: ["showroomprive", "showroomprivé"], categorie: "mode", promo: null },
  { nom: "La Redoute", domaine: "laredoute.fr", alias: ["la redoute", "redoute"], categorie: "maison", promo: null },
  { nom: "La Poste", domaine: "laposte.fr", alias: ["la poste"], categorie: "tout", promo: null },

  // ── High-tech et informatique ──
  { nom: "LDLC", domaine: "ldlc.com", recherche: "https://www.ldlc.com/navigation/{q}/", alias: ["ldlc"], categorie: "hightech", promo: null },
  { nom: "Materiel.net", domaine: "materiel.net", recherche: "https://www.materiel.net/recherche/{q}/", alias: ["materiel.net", "materiel net"], categorie: "hightech", promo: null },
  { nom: "TopAchat", domaine: "topachat.com", alias: ["topachat", "top achat"], categorie: "hightech", promo: null },
  { nom: "GrosBill", domaine: "grosbill.com", alias: ["grosbill"], categorie: "hightech", promo: null },
  { nom: "Rue du Commerce", domaine: "rueducommerce.fr", alias: ["rue du commerce", "rueducommerce"], categorie: "hightech", promo: null },
  { marque: true, nom: "Apple", domaine: "apple.com", alias: ["apple", "apple store"], categorie: "hightech", promo: null },
  { marque: true, nom: "Samsung", domaine: "samsung.com", alias: ["samsung"], categorie: "hightech", promo: null },
  { marque: true, nom: "Xiaomi", domaine: "mi.com", alias: ["xiaomi"], categorie: "hightech", promo: null },
  { marque: true, nom: "Lenovo", domaine: "lenovo.com", alias: ["lenovo"], categorie: "hightech", promo: null },
  { marque: true, nom: "HP", domaine: "hp.com", alias: ["hp store", "hewlett"], categorie: "hightech", promo: null },
  { marque: true, nom: "Dell", domaine: "dell.com", alias: ["dell"], categorie: "hightech", promo: null },
  { marque: true, nom: "Asus", domaine: "asus.com", alias: ["asus"], categorie: "hightech", promo: null },
  { marque: true, nom: "Acer", domaine: "acer.com", alias: ["acer"], categorie: "hightech", promo: null },
  { marque: true, nom: "Bose", domaine: "bose.fr", alias: ["bose"], categorie: "hightech", promo: null },
  { marque: true, nom: "Sony", domaine: "sony.fr", alias: ["sony"], categorie: "hightech", promo: null },
  { marque: true, nom: "JBL", domaine: "jbl.com", alias: ["jbl"], categorie: "hightech", promo: null },
  { marque: true, nom: "Sonos", domaine: "sonos.com", alias: ["sonos"], categorie: "hightech", promo: null },
  { nom: "Back Market", domaine: "backmarket.fr", recherche: "https://www.backmarket.fr/fr-fr/search?q={q}", alias: ["back market", "backmarket"], categorie: "hightech", promo: null },
  { nom: "Recommerce", domaine: "recommerce.com", alias: ["recommerce"], categorie: "hightech", promo: null },
  { nom: "SFR", domaine: "sfr.fr", alias: ["sfr"], categorie: "hightech", promo: null },
  { nom: "Orange", domaine: "boutique.orange.fr", alias: ["orange"], categorie: "hightech", promo: null },
  { nom: "Bouygues Telecom", domaine: "bouyguestelecom.fr", alias: ["bouygues"], categorie: "hightech", promo: null },
  { nom: "Free", domaine: "free.fr", alias: ["free mobile", "free"], categorie: "hightech", promo: null },

  // ── Gaming ──
  { nom: "Micromania", domaine: "micromania.fr", recherche: "https://www.micromania.fr/recherche?q={q}", alias: ["micromania", "micromania-zing"], categorie: "gaming", promo: null },
  { nom: "Instant Gaming", domaine: "instant-gaming.com", recherche: "https://www.instant-gaming.com/fr/rechercher/?q={q}", alias: ["instant gaming", "instant-gaming"], categorie: "gaming", promo: null },
  { nom: "Gamesplanet", domaine: "gamesplanet.com", alias: ["gamesplanet"], categorie: "gaming", promo: null },
  { marque: true, nom: "Nintendo", domaine: "nintendo.com", alias: ["nintendo", "nintendo eshop"], categorie: "gaming", promo: null },
  { marque: true, nom: "PlayStation Store", domaine: "playstation.com", alias: ["playstation", "psn", "ps store"], categorie: "gaming", promo: null },
  { marque: true, nom: "Xbox", domaine: "xbox.com", alias: ["xbox", "microsoft store"], categorie: "gaming", promo: null },
  { nom: "Steam", domaine: "store.steampowered.com", alias: ["steam"], categorie: "gaming", promo: null },
  { nom: "Epic Games", domaine: "store.epicgames.com", alias: ["epic games", "epic"], categorie: "gaming", promo: null },
  { nom: "GOG", domaine: "gog.com", alias: ["gog"], categorie: "gaming", promo: null },
  { nom: "Fnac Gaming", domaine: "jeux-video.fnac.com", alias: [], categorie: "gaming", promo: null },

  // ── Maison, bricolage, jardin ──
  { nom: "Ikea", domaine: "ikea.com", recherche: "https://www.ikea.com/fr/fr/search/?q={q}", alias: ["ikea"], categorie: "maison", promo: null },
  { nom: "Conforama", domaine: "conforama.fr", recherche: "https://www.conforama.fr/recherche?q={q}", alias: ["conforama"], categorie: "maison", promo: null },
  { nom: "But", domaine: "but.fr", recherche: "https://www.but.fr/recherche?q={q}", alias: ["but.fr", "but "], categorie: "maison", promo: null },
  { nom: "Maisons du Monde", domaine: "maisonsdumonde.com", recherche: "https://www.maisonsdumonde.com/FR/fr/search?q={q}", alias: ["maisons du monde", "maisonsdumonde"], categorie: "maison", promo: null },
  { nom: "Alinéa", domaine: "alinea.com", alias: ["alinea", "alinéa"], categorie: "maison", promo: null },
  { nom: "Leroy Merlin", domaine: "leroymerlin.fr", recherche: "https://www.leroymerlin.fr/produits/recherche.html?mot={q}", alias: ["leroy merlin", "leroymerlin"], categorie: "maison", promo: null },
  { nom: "Castorama", domaine: "castorama.fr", recherche: "https://www.castorama.fr/search?q={q}", alias: ["castorama", "casto"], categorie: "maison", promo: null },
  { nom: "Brico Dépôt", domaine: "bricodepot.fr", alias: ["brico depot", "brico dépôt", "bricodepot"], categorie: "maison", promo: null },
  { nom: "Bricomarché", domaine: "bricomarche.com", alias: ["bricomarche", "bricomarché"], categorie: "maison", promo: null },
  { nom: "Mr Bricolage", domaine: "mr-bricolage.fr", alias: ["mr bricolage", "monsieur bricolage"], categorie: "maison", promo: null },
  { nom: "ManoMano", domaine: "manomano.fr", recherche: "https://www.manomano.fr/recherche/{q}", alias: ["manomano", "mano mano"], categorie: "maison", promo: null },
  { nom: "Gamm Vert", domaine: "gammvert.fr", alias: ["gamm vert", "gammvert"], categorie: "maison", promo: null },
  { nom: "Jardiland", domaine: "jardiland.com", alias: ["jardiland"], categorie: "maison", promo: null },
  { nom: "Truffaut", domaine: "truffaut.com", recherche: "https://www.truffaut.com/recherche?q={q}", alias: ["truffaut"], categorie: "maison", promo: null },
  { nom: "Delamaison", domaine: "delamaison.fr", alias: ["delamaison"], categorie: "maison", promo: null },
  { nom: "Vente-unique", domaine: "vente-unique.com", alias: ["vente unique", "vente-unique"], categorie: "maison", promo: null },

  // ── Électroménager et cuisine ──
  { nom: "Electro Dépôt", domaine: "electrodepot.fr", recherche: "https://www.electrodepot.fr/catalogsearch/result/?q={q}", alias: ["electro depot", "électro dépôt", "electrodepot"], categorie: "maison", promo: null },
  { nom: "Ubaldi", domaine: "ubaldi.com", alias: ["ubaldi"], categorie: "maison", promo: null },
  { nom: "Villatech", domaine: "villatech.fr", alias: ["villatech"], categorie: "maison", promo: null },
  { marque: true, nom: "SEB", domaine: "seb.fr", alias: ["seb", "groupe seb"], categorie: "maison", promo: null },
  { marque: true, nom: "Moulinex", domaine: "moulinex.fr", alias: ["moulinex"], categorie: "maison", promo: null },
  { marque: true, nom: "Tefal", domaine: "tefal.fr", alias: ["tefal"], categorie: "maison", promo: null },
  { marque: true, nom: "Krups", domaine: "krups.fr", alias: ["krups"], categorie: "maison", promo: null },
  { marque: true, nom: "Rowenta", domaine: "rowenta.fr", alias: ["rowenta"], categorie: "maison", promo: null },
  { marque: true, nom: "Dyson", domaine: "dyson.fr", alias: ["dyson"], categorie: "maison", promo: null },
  { marque: true, nom: "Nespresso", domaine: "nespresso.com", alias: ["nespresso"], categorie: "alimentaire", promo: null },

  // ── Mode et chaussures ──
  { nom: "Zalando", domaine: "zalando.fr", recherche: "https://www.zalando.fr/recherche/?q={q}", alias: ["zalando"], categorie: "mode", promo: null },
  { nom: "Kiabi", domaine: "kiabi.com", recherche: "https://www.kiabi.com/recherche?text={q}", alias: ["kiabi"], categorie: "mode", promo: null },
  { nom: "Vertbaudet", domaine: "vertbaudet.fr", alias: ["vertbaudet"], categorie: "mode", promo: null },
  { nom: "Decathlon", domaine: "decathlon.fr", recherche: "https://www.decathlon.fr/search?Ntt={q}", alias: ["decathlon", "décathlon"], categorie: "sport", promo: null },
  { nom: "Go Sport", domaine: "go-sport.com", recherche: "https://www.go-sport.com/recherche?q={q}", alias: ["go sport", "gosport"], categorie: "sport", promo: null },
  { nom: "Intersport", domaine: "intersport.fr", recherche: "https://www.intersport.fr/recherche/?q={q}", alias: ["intersport"], categorie: "sport", promo: null },
  { marque: true, nom: "Nike", domaine: "nike.com", recherche: "https://www.nike.com/fr/w?q={q}", alias: ["nike"], categorie: "sport", promo: null },
  { marque: true, nom: "Adidas", domaine: "adidas.fr", recherche: "https://www.adidas.fr/recherche?q={q}", alias: ["adidas"], categorie: "sport", promo: null },
  { marque: true, nom: "Puma", domaine: "puma.com", alias: ["puma"], categorie: "sport", promo: null },
  { marque: true, nom: "New Balance", domaine: "newbalance.fr", alias: ["new balance"], categorie: "sport", promo: null },
  { marque: true, nom: "Asics", domaine: "asics.com", alias: ["asics"], categorie: "sport", promo: null },
  { nom: "Courir", domaine: "courir.com", alias: ["courir"], categorie: "mode", promo: null },
  { nom: "Sarenza", domaine: "sarenza.com", recherche: "https://www.sarenza.com/recherche?q={q}", alias: ["sarenza"], categorie: "mode", promo: null },
  { nom: "Spartoo", domaine: "spartoo.com", alias: ["spartoo"], categorie: "mode", promo: null },
  { marque: true, nom: "Celio", domaine: "celio.com", alias: ["celio"], categorie: "mode", promo: null },
  { marque: true, nom: "Jules", domaine: "jules.com", alias: ["jules"], categorie: "mode", promo: null },
  { marque: true, nom: "Promod", domaine: "promod.fr", alias: ["promod"], categorie: "mode", promo: null },
  { marque: true, nom: "Undiz", domaine: "undiz.com", alias: ["undiz"], categorie: "mode", promo: null },
  { marque: true, nom: "Etam", domaine: "etam.com", alias: ["etam"], categorie: "mode", promo: null },
  { marque: true, nom: "Uniqlo", domaine: "uniqlo.com", alias: ["uniqlo"], categorie: "mode", promo: null },
  { marque: true, nom: "H&M", domaine: "hm.com", alias: ["h&m", "h et m"], categorie: "mode", promo: null },
  { marque: true, nom: "Zara", domaine: "zara.com", recherche: "https://www.zara.com/fr/fr/search?searchTerm={q}", alias: ["zara"], categorie: "mode", promo: null },
  { nom: "Vinted", domaine: "vinted.fr", alias: ["vinted"], categorie: "mode", promo: null },

  // ── Beauté et santé ──
  { nom: "Sephora", domaine: "sephora.fr", recherche: "https://www.sephora.fr/recherche?q={q}", alias: ["sephora", "séphora"], categorie: "beaute", promo: null },
  { nom: "Marionnaud", domaine: "marionnaud.fr", alias: ["marionnaud"], categorie: "beaute", promo: null },
  { nom: "Nocibé", domaine: "nocibe.fr", alias: ["nocibe", "nocibé"], categorie: "beaute", promo: null },
  { marque: true, nom: "Yves Rocher", domaine: "yves-rocher.fr", alias: ["yves rocher"], categorie: "beaute", promo: null },
  { marque: true, nom: "L'Occitane", domaine: "loccitane.com", alias: ["occitane"], categorie: "beaute", promo: null },
  { nom: "Parashop", domaine: "parashop.com", alias: ["parashop"], categorie: "beaute", promo: null },
  { nom: "Newpharma", domaine: "newpharma.fr", alias: ["newpharma"], categorie: "beaute", promo: null },
  { nom: "Pharmacie Lafayette", domaine: "pharmacielafayette.com", alias: ["pharmacie lafayette"], categorie: "beaute", promo: null },

  // ── Culture, jouets, divers ──
  { nom: "Cultura", domaine: "cultura.com", recherche: "https://www.cultura.com/search?q={q}", alias: ["cultura"], categorie: "tout", promo: null },
  { nom: "King Jouet", domaine: "king-jouet.com", alias: ["king jouet", "king-jouet"], categorie: "tout", promo: null },
  { nom: "JouéClub", domaine: "joueclub.fr", alias: ["joueclub", "jouéclub"], categorie: "tout", promo: null },
  { nom: "Nature & Découvertes", domaine: "natureetdecouvertes.com", alias: ["nature et decouvertes", "nature & découvertes"], categorie: "tout", promo: null },
  { marque: true, nom: "Lego", domaine: "lego.com", alias: ["lego"], categorie: "tout", promo: null },
  { nom: "Momox", domaine: "momox-shop.fr", alias: ["momox"], categorie: "tout", promo: null },

  // ── Auto et mobilité ──
  { nom: "Norauto", domaine: "norauto.fr", recherche: "https://www.norauto.fr/recherche?q={q}", alias: ["norauto"], categorie: "auto", promo: null },
  { nom: "Feu Vert", domaine: "feuvert.fr", alias: ["feu vert", "feuvert"], categorie: "auto", promo: null },
  { nom: "Midas", domaine: "midas.fr", alias: ["midas"], categorie: "auto", promo: null },
  { nom: "Oscaro", domaine: "oscaro.com", recherche: "https://www.oscaro.com/recherche?q={q}", alias: ["oscaro"], categorie: "auto", promo: null },
  { nom: "Mister Auto", domaine: "mister-auto.com", alias: ["mister auto", "mister-auto"], categorie: "auto", promo: null },
  { nom: "Roady", domaine: "roady.fr", alias: ["roady"], categorie: "auto", promo: null },
];

/* Des noms d'enseigne qui sont aussi des mots courants. « Courir » est un
   verbe, « But » une conjonction, « Orange » une couleur : les chercher tels
   quels dans le titre d'un bon plan attribuerait des ventes au hasard. On ne
   les accepte que précédés d'un marqueur qui désigne un vendeur. */
const AMBIGUS = new Set(["but", "but.fr", "free", "free mobile", "courir", "jules", "casino", "orange", "cora", "midas", "roady", "apple", "seb"]);

/** Marqueurs qui, devant un nom, annoncent une enseigne : « chez Fnac », « @Darty ». */
const MARQUEUR = String.raw`(?:chez|sur|@|à|a|de|par|vendu par|magasin)\s+`;

/** Sans accents, en minuscules, ponctuation ramenée à des espaces. */
function normaliser(texte) {
  return String(texte || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9&.]+/g, " ")
    .trim();
}

/** Toutes les façons d'écrire une enseigne, la plus longue d'abord. */
function appellations(m) {
  return [m.nom, ...(m.alias || [])]
    .map(normaliser)
    .filter((a) => a.length >= 2)
    .sort((a, b) => b.length - a.length);
}

// Index construit une fois : cent vingt marchands relus pour chaque offre
// d'un flux de cinquante articles feraient six mille comparaisons par scan.
const PAR_DOMAINE = new Map();
for (const m of MARCHANDS) PAR_DOMAINE.set(m.domaine.toLowerCase(), m);

const PAR_APPELLATION = [];
for (const m of MARCHANDS) {
  for (const a of appellations(m)) PAR_APPELLATION.push({ appellation: a, marchand: m, ambigu: AMBIGUS.has(a) });
}
// Les appellations longues passent avant : « fnac darty » doit gagner sur
// « fnac » quand les deux figurent dans le texte.
PAR_APPELLATION.sort((x, y) => y.appellation.length - x.appellation.length);

/**
 * Reconnaît l'enseigne d'un domaine, sous-domaines compris.
 *
 * « www.boutique.orange.fr » doit rendre Orange : on remonte les étiquettes
 * une à une plutôt que d'exiger une égalité stricte, sinon la moitié des
 * liens marchands ne seraient jamais reconnus.
 */
function marchandDepuisDomaine(domaine) {
  if (!domaine) return null;
  const propre = String(domaine).toLowerCase().replace(/^www\./, "");
  const parts = propre.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const candidat = parts.slice(i).join(".");
    const trouve = PAR_DOMAINE.get(candidat);
    if (trouve) return trouve;
  }
  return null;
}

/**
 * Reconnaît l'enseigne citée dans un texte libre — le titre ou la
 * description d'un bon plan.
 *
 * C'est ce qui rend exploitables les flux d'agrégateurs : leurs liens
 * repassent par leur propre domaine, donc le domaine ne dit rien, mais le
 * titre nomme presque toujours le marchand (« Casque Sony à 199 € chez
 * Boulanger »).
 */
function marchandDepuisTexte(texte) {
  const propre = normaliser(texte);
  if (!propre) return null;
  // Une marque citée dans un titre n'est pas le vendeur : « Aspirateur
  // Dyson chez Boulanger » se vend chez Boulanger. On retient donc la
  // marque en réserve et on ne s'en sert que si aucune enseigne n'est
  // nommée — auquel cas elle vend probablement en direct.
  let repli = null;
  for (const { appellation, marchand, ambigu } of PAR_APPELLATION) {
    const mot = appellation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const motif = ambigu
      ? new RegExp(`(?:^|\\s)${MARQUEUR}${mot}(?![a-z0-9])`)
      : new RegExp(`(?:^|\\s)${mot}(?![a-z0-9])`);
    if (!motif.test(propre)) continue;
    if (!marchand.marque) return marchand;
    if (!repli) repli = marchand;
  }
  return repli;
}

/** L'enseigne d'une offre : le lien fait foi, le texte prend le relais. */
function reconnaitreMarchand({ url, texte } = {}) {
  let domaine = null;
  try {
    domaine = url ? new URL(String(url)).hostname : null;
  } catch {
    domaine = null;
  }
  return marchandDepuisDomaine(domaine) || marchandDepuisTexte(texte) || null;
}

/** Adresse publique où l'enseigne regroupe ses promotions, ou null. */
function pagePromo(m) {
  return m && m.promo ? `https://www.${m.domaine.replace(/^www\./, "")}${m.promo}` : null;
}

/* Bruit typique des titres d'agrégateurs : mentions entre crochets, tailles,
   plateformes, précisions de livraison. Utile à lire pour un humain, nuisible
   dans une recherche marchande — « [Via App] » ne trouve rien chez Boulanger. */
const BRUIT_TITRE = [
  /\[[^\]]{1,40}\]/g,                        // [Via App], [Edenred/Bourso]
  /\((?:d[ée]mat[ée]rialis[ée]|steam|epic|gog|pc|ps5|xbox)[^)]*\)/gi,
  /\b(?:tailles?|pointures?)\s+du\s+\S+\s+au\s+\S+/gi,
  /\bvendu\s+sans\s+[^,–—-]{0,30}/gi,
  /\bvia\s+(?:app|application)\b/gi,
];

/**
 * Requête marchande tirée d'un titre de bon plan.
 *
 * On garde la tête du titre — marque et modèle — et on coupe à la première
 * énumération : « Casque Sony WH-1000XM5 - Noir, Bluetooth, 30h » cherche
 * « Casque Sony WH-1000XM5 ». Chercher le titre entier ne rend rien chez la
 * plupart des marchands, dont les moteurs exigent tous les mots.
 */
function requeteDeTitre(titre) {
  let t = String(titre || "");
  for (const motif of BRUIT_TITRE) t = t.replace(motif, " ");
  t = t.split(/\s+[-–—]\s+/)[0];
  t = t.replace(/\s+/g, " ").trim();
  // Un titre réduit à rien ne ferait qu'une recherche vide : on reprend
  // alors le titre d'origine, nettoyé de ses espaces.
  return (t.length >= 3 ? t : String(titre || "").replace(/\s+/g, " ").trim()).slice(0, 90);
}

/**
 * Adresse où envoyer l'acheteur, chez le marchand et nulle part ailleurs.
 *
 * Les agrégateurs ne publient pas l'URL du produit — c'est leur fonds de
 * commerce. On sait en revanche QUI vend. Envoyer l'acheteur sur la page du
 * bon plan chez l'agrégateur serait lui offrir notre visiteur ; on l'envoie
 * donc chercher l'article chez le marchand.
 *
 * Trois niveaux : la recherche du marchand quand on sait la construire, sa
 * page d'accueil sinon, et null quand on ne connaît même pas son domaine —
 * auquel cas mieux vaut une carte sans lien qu'un lien vers un concurrent.
 */
function lienMarchand({ marchand, domaine, titre } = {}) {
  return sortieMarchand({ marchand, domaine, titre }).url;
}

/**
 * Le lien de sortie ET sa nature.
 *
 * La nature compte autant que l'adresse : une carte qui annonce « Voir le
 * produit » et ouvre une page de résultats de recherche trompe son lecteur.
 * L'interface a besoin de savoir ce qu'elle promet.
 *
 *   "produit"   — la fiche exacte, relevée par nous
 *   "recherche" — la recherche du marchand sur le nom de l'article
 *   "marchand"  — sa page d'accueil, faute de mieux
 */
function sortieMarchand({ marchand, domaine, titre } = {}) {
  const connu = marchand || (domaine ? marchandDepuisDomaine(domaine) : null);
  if (connu && connu.recherche) {
    return {
      url: connu.recherche.replace("{q}", encodeURIComponent(requeteDeTitre(titre))),
      type: "recherche",
      marchand: connu,
    };
  }
  const hote = (connu && connu.domaine) || (domaine ? String(domaine).replace(/^www\./, "") : null);
  return {
    url: hote ? `https://www.${hote}/` : null,
    type: hote ? "marchand" : null,
    marchand: connu || null,
  };
}

/** Domaine d'une enseigne, pour aller chercher son logo. */
function domaineDeMarchand(nom) {
  const m = nom ? marchandDepuisTexte(nom) : null;
  return m ? m.domaine : null;
}

/**
 * Le domaine à afficher pour le logo d'une enseigne.
 *
 * Trois sources, de la plus sûre à la plus générale : ce que la collecte a
 * rangé dans l'offre, l'hôte du lien de sortie, puis le registre par le nom.
 *
 * L'hôte du lien vient avant le registre parce qu'il est plus précis — une
 * offre Amazon.es doit porter le logo d'amazon.es, pas celui d'amazon.fr —
 * et il ne peut pas désigner un agrégateur : la règle de sortie reconstruit
 * toujours le lien vers le marchand, et une offre sans lien constructible
 * n'est pas publiée. On l'écarte tout de même explicitement, pour que ce
 * jour où cette règle changerait, le logo de Dealabs n'apparaisse pas sur
 * nos cartes.
 *
 * Sans ce repli, dix-huit cartes sur quarante-neuf s'affichaient en
 * initiales, dont six Amazon : elles avaient été collectées avant que le
 * champ n'existe.
 */
function domainePourLogo({ domaine, url, marchand } = {}) {
  if (domaine) return String(domaine).replace(/^www\./, "");

  const hote = hoteDeLien(url);
  if (hote && !AGREGATEURS.has(hote.split(".").slice(-2).join("."))) return hote;

  return domaineDeMarchand(marchand);
}

/** Les plates-formes de bons plans, dont le logo ne doit jamais figurer sur une carte. */
const AGREGATEURS = new Set([
  "dealabs.com", "mydealz.de", "hotukdeals.com", "pepper.pl", "preisjaeger.at",
  "chollometro.com", "pepper.it", "promodescuentos.com", "pelando.com.br",
]);

function hoteDeLien(url) {
  if (!url) return null;
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

module.exports = {
  domainePourLogo,
  MARCHANDS,
  marchandDepuisDomaine,
  marchandDepuisTexte,
  reconnaitreMarchand,
  lienMarchand,
  sortieMarchand,
  domaineDeMarchand,
  requeteDeTitre,
  pagePromo,
  normaliser,
};
