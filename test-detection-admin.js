// Vérifie les outils de qualité de détection : réglages de l'algorithme,
// liste noire, rejet d'anomalies et gestion du catalogue.
const {
  db, createUser, REGLAGES_DEFAUT, reglages, reglagesDetailles, definirReglage,
  listBlacklist, ajouterBlacklist, retirerBlacklist, offreBannie,
  offreRejetee, rejeterOffre, listRejets, annulerRejet,
  listCatalogItems, ajouterCatalogItem, basculerCatalogItem, supprimerCatalogItem,
  catalogItemsActifs,
} = require("./src/db");
const { analyzeOffers, filterRelevantOffers } = require("./src/algorithm");
const { produitsAScanner } = require("./src/scanBatch");

let echecs = 0;
const verifie = (l, c) => { console.log(c ? `✅ ${l}` : `❌ ÉCHEC — ${l}`); if (!c) echecs++; };
const admin = createUser("admin@t.fr", "x");

// Un lot où une seule offre est manifestement anormale (-70 %).
const lot = () => [
  { name: "Casque Sony WH-1000XM5", seller: "Amazon", price: 120 },
  { name: "Casque Sony WH-1000XM5", seller: "Fnac", price: 390 },
  { name: "Casque Sony WH-1000XM5", seller: "Darty", price: 400 },
  { name: "Casque Sony WH-1000XM5", seller: "Boulanger", price: 410 },
];

console.log("── Réglages de l'algorithme ──");
verifie("Valeurs d'origine au départ", reglages().seuilErreur === REGLAGES_DEFAUT.seuilErreur.valeur);
verifie("Aucun réglage marqué modifié", reglagesDetailles().every((r) => r.modifie === false));
verifie("Bornes exposées à l'interface", reglagesDetailles().every((r) => r.min < r.max && r.libelle));

const avant = analyzeOffers(lot()).find((o) => o.seller === "Amazon");
console.log(`  Amazon à -${avant.pct}% → ${avant.verdict}`);
verifie("Verdict « erreur » avec le seuil d'origine (60 %)", avant.verdict === "erreur");

verifie("Seuil relevé accepté", definirReglage(admin.id, "seuilErreur", 80).ok === true);
verifie("Le cache est bien invalidé", reglages().seuilErreur === 80);
const apres = analyzeOffers(lot()).find((o) => o.seller === "Amazon");
console.log(`  seuil à 80 % → ${apres.verdict}`);
verifie("La même offre n'est plus une erreur", apres.verdict === "deal");
verifie("Le réglage est signalé comme modifié", reglagesDetailles().find((r) => r.cle === "seuilErreur").modifie === true);

verifie("Valeur hors bornes refusée", definirReglage(admin.id, "seuilErreur", 5).ok === false);
verifie("Valeur non numérique refusée", definirReglage(admin.id, "seuilErreur", "beaucoup").ok === false);
verifie("Réglage inconnu refusé", definirReglage(admin.id, "inventé", 10).ok === false);
verifie("Retour à la valeur d'origine", definirReglage(admin.id, "seuilErreur", null).ok === true);
verifie("La valeur d'origine est bien restaurée", reglages().seuilErreur === 60);
verifie("Plus rien n'est marqué modifié", reglagesDetailles().find((r) => r.cle === "seuilErreur").modifie === false);

console.log("\n── Plancher de confiance ──");
definirReglage(admin.id, "confianceMin", 90);
const filtre = analyzeOffers(lot()).find((o) => o.seller === "Amazon");
console.log(`  confiance ${filtre.confidence} contre un plancher de 90 → ${filtre.verdict}`);
verifie("Une détection peu sûre est ramenée à « normal »", filtre.verdict === "normal");
definirReglage(admin.id, "confianceMin", null);
verifie("Sans plancher, l'anomalie revient", analyzeOffers(lot()).find((o) => o.seller === "Amazon").verdict === "erreur");

console.log("\n── Liste noire ──");
const offreAmazon = { name: "Casque Sony WH-1000XM5", seller: "Amazon", price: 120 };
verifie("Rien n'est banni au départ", offreBannie(offreAmazon) === false);
verifie("Ajout d'un marchand", ajouterBlacklist(admin.id, "marchand", "Amazon", "test").ok === true);
verifie("L'offre du marchand est bannie", offreBannie(offreAmazon) === true);
verifie("Un autre marchand n'est pas touché", offreBannie({ name: "X", seller: "Fnac", price: 10 }) === false);
verifie("Doublon refusé", ajouterBlacklist(admin.id, "marchand", "Amazon").ok === false);
verifie("Type inconnu refusé", ajouterBlacklist(admin.id, "planete", "Mars").ok === false);
verifie("Valeur trop courte refusée", ajouterBlacklist(admin.id, "motif", "a").ok === false);

const filtrees = filterRelevantOffers(lot(), "Casque Sony WH-1000XM5");
console.log(`  ${filtrees.length} offres retenues sur 4`);
verifie("Le filtrage écarte le marchand banni", filtrees.length === 3 && !filtrees.some((o) => o.seller === "Amazon"));

verifie("Ajout d'un motif de titre", ajouterBlacklist(admin.id, "motif", "coque").ok === true);
verifie("Un titre contenant le motif est banni", offreBannie({ name: "Coque pour iPhone 15", seller: "Fnac", price: 9 }) === true);
verifie("La casse est ignorée", offreBannie({ name: "COQUE renforcée", seller: "Fnac", price: 9 }) === true);
verifie("2 entrées listées", listBlacklist().length === 2);
verifie("L'auteur de l'ajout est joint", listBlacklist().every((b) => b.ajoute_par === "admin@t.fr"));

const idMarchand = listBlacklist().find((b) => b.valeur === "Amazon").id;
verifie("Retrait accepté", retirerBlacklist(admin.id, idMarchand).ok === true);
verifie("Le marchand n'est plus banni", offreBannie(offreAmazon) === false);
verifie("Retrait d'une entrée inexistante refusé", retirerBlacklist(admin.id, 9999).ok === false);

console.log("\n── Rejet d'une anomalie ──");
const anomalie = { name: "Casque Sony WH-1000XM5", seller: "Amazon", price: 120 };
verifie("Rien n'est rejeté au départ", offreRejetee(anomalie) === false);
verifie("Rejet accepté", rejeterOffre(admin.id, { ...anomalie, motif: "mauvaise variante" }).ok === true);
verifie("L'offre est reconnue comme rejetée", offreRejetee(anomalie) === true);
verifie("Un autre prix du même produit n'est pas touché", offreRejetee({ ...anomalie, price: 130 }) === false);
verifie("Un autre marchand n'est pas touché", offreRejetee({ ...anomalie, seller: "Fnac" }) === false);
verifie("Une formulation différente du même produit est reconnue",
  offreRejetee({ name: "casque sony wh 1000xm5", seller: "Amazon", price: 120 }) === true);
const doublon = rejeterOffre(admin.id, anomalie);
verifie("Rejeter deux fois ne crée pas de doublon", doublon.ok === true && doublon.deja === true);
verifie("Offre incomplète refusée", rejeterOffre(admin.id, { name: "X" }).ok === false);
verifie("Le motif est conservé", listRejets()[0].motif === "mauvaise variante");
verifie("Annulation du rejet", annulerRejet(admin.id, listRejets()[0].id).ok === true);
verifie("L'anomalie revient en circulation", offreRejetee(anomalie) === false);
verifie("Annuler un rejet inexistant refusé", annulerRejet(admin.id, 9999).ok === false);

console.log("\n── Catalogue ──");
const nbFichier = produitsAScanner().length;
verifie("Aucun produit ajouté au départ", listCatalogItems().length === 0);
verifie("Ajout accepté", ajouterCatalogItem(admin.id, "Théière connectée Xiaomi", "maison").ok === true);
verifie("Il apparaît dans la liste", listCatalogItems()[0].name === "Théière connectée Xiaomi");
verifie("Il est actif par défaut", catalogItemsActifs().length === 1);
verifie("Il entre dans la rotation de scan", produitsAScanner().length === nbFichier + 1);
verifie("Doublon refusé", ajouterCatalogItem(admin.id, "Théière connectée Xiaomi", "maison").ok === false);
verifie("Nom trop court refusé", ajouterCatalogItem(admin.id, "TV").ok === false);
verifie("Un produit déjà dans le fichier n'est pas dupliqué",
  ajouterCatalogItem(admin.id, "iPhone 15 128 Go", "hightech").ok === true && produitsAScanner().length === nbFichier + 2 - 1);

const id = listCatalogItems().find((c) => c.name === "Théière connectée Xiaomi").id;
verifie("Désactivation", basculerCatalogItem(admin.id, id, false).ok === true);
verifie("Il sort de la rotation", catalogItemsActifs().length === 1);
verifie("Réactivation", basculerCatalogItem(admin.id, id, true).ok === true);
verifie("Suppression", supprimerCatalogItem(admin.id, id).ok === true);
verifie("Suppression d'un produit inexistant refusée", supprimerCatalogItem(admin.id, 9999).ok === false);

console.log(`\n${echecs === 0 ? "Tous les tests passent." : echecs + " test(s) en échec."}`);
db.close();
process.exit(echecs === 0 ? 0 : 1);
