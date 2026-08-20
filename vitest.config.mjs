// vitest.config.js — Suite de tests du backend.
//
// Les 22 scripts test-*.js d'origine s'exécutaient un par un et signalaient
// leurs résultats par des console.log avec des ✅/❌ : rien ne faisait échouer
// la commande, et `npm test` n'en lançait qu'un seul. Ils sont conservés
// (ils restent utiles à lire) mais la vérification automatisée passe désormais
// par ici.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    // Chaque fichier de test reçoit sa propre base SQLite temporaire (voir
    // tests/setup.js) : sans isolation, deux fichiers qui écrivent des
    // snapshots se contamineraient mutuellement leurs historiques de prix.
    isolate: true,
    setupFiles: ["tests/setup.js"],
    testTimeout: 15000,
  },
});
