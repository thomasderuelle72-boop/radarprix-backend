// tests/setup.js — Isole chaque fichier de test dans sa propre base.
//
// db.js lit DB_PATH au moment du require : il faut donc définir la variable
// AVANT que le moindre module du backend ne soit chargé, ce que garantit
// setupFiles dans vitest.config.js.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const dossier = mkdtempSync(join(tmpdir(), "radarprix-test-"));
process.env.DB_PATH = join(dossier, "test.sqlite");

// JWT_SECRET est exigé par auth.js dès qu'un jeton est signé. Valeur fixe et
// sans valeur réelle : elle ne sert qu'à faire tourner les tests.
process.env.JWT_SECRET = "secret-de-test-sans-valeur";

// Aucun test ne doit partir sur le réseau. Les clés absentes suffisent à
// désactiver SerpApi, Bright Data et Resend — c'est le comportement voulu
// en local, et les tests vérifient justement cette dégradation silencieuse.
delete process.env.SERPAPI_KEY;
delete process.env.BRIGHT_DATA_BROWSER_HOST;
delete process.env.RESEND_API_KEY;
delete process.env.STRACKR_API_KEY;
delete process.env.AWIN_API_TOKEN;

afterAll(() => {
  rmSync(dossier, { recursive: true, force: true });
});
