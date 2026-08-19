// Vérifie parseGoogleShoppingHtml() sur un extrait HTML minimal reproduisant
// la structure ciblée (lien de fiche produit + rôle ARIA "heading" + prix en
// euros). Ne remplace PAS un test contre le vrai HTML de Google (impossible
// à obtenir depuis cet environnement, api.brightdata.com y est bloqué par la
// politique réseau du bac à sable) : à re-valider via les logs Railway après
// déploiement, et à ajuster si Google a changé sa structure entre-temps.
const { parseGoogleShoppingHtml } = require("./src/brightdata");

console.log("── Extraction de base : titre, prix, image ──");
const html1 = `
  <div>
    <div>
      <a href="/shopping/product/1?prds=abc" aria-label="iPhone 15 128 Go">
        <div role="heading">iPhone 15 128 Go</div>
        <img src="https://img.example/1.jpg" />
        <span>699,99 €</span>
      </a>
    </div>
    <div>
      <a href="/shopping/product/2?prds=def" aria-label="iPhone 15 256 Go">
        <div role="heading">iPhone 15 256 Go</div>
        <img src="https://img.example/2.jpg" />
        <span>1 299,00 €</span>
      </a>
    </div>
  </div>
`;
const offers1 = parseGoogleShoppingHtml(html1);
console.log(`  ${offers1.length} offres extraites`);
console.log(JSON.stringify(offers1, null, 2));
console.log(
  offers1.length === 2 && offers1[0].price === 699.99 && offers1[1].price === 1299
    ? "✅ Titre, prix (avec séparateur de milliers) et image bien extraits\n"
    : "❌ ÉCHEC\n"
);

console.log("── Jamais de lien Google en repli (url doit rester null) ──");
console.log(
  offers1.every((o) => o.url === null)
    ? "✅ Aucune offre n'expose de lien Google comme lien final\n"
    : "❌ ÉCHEC\n"
);

console.log("── Déduplication d'un même produit apparu deux fois ──");
const html2 = `
  <div>
    <div>
      <a href="/shopping/product/1" aria-label="PS5 Slim">
        <div role="heading">PS5 Slim</div>
        <span>449,99 €</span>
      </a>
    </div>
    <div>
      <a href="/shopping/product/1" aria-label="PS5 Slim">
        <div role="heading">PS5 Slim</div>
        <span>449,99 €</span>
      </a>
    </div>
  </div>
`;
const offers2 = parseGoogleShoppingHtml(html2);
console.log(`  ${offers2.length} offre(s) après dédoublonnage`);
console.log(offers2.length === 1 ? "✅ Doublon bien filtré\n" : "❌ ÉCHEC\n");

console.log("── HTML sans résultat Shopping : liste vide, pas d'erreur ──");
const offers3 = parseGoogleShoppingHtml("<html><body>Aucun résultat</body></html>");
console.log(offers3.length === 0 ? "✅ Liste vide gérée proprement\n" : "❌ ÉCHEC\n");

console.log("Tests terminés.");
