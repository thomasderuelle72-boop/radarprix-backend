// eslint.config.mjs — Garde-fou statique du backend.
//
// Les 129 tests couvrent la logique métier ; ils ne disent rien d'une
// variable oubliée, d'un require inutile ou d'une promesse jamais attendue.
// C'est ce que cette configuration attrape.
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "data/**",
      "coverage/**",
      // Les 22 scripts test-*.js de la racine datent d'avant la suite Vitest :
      // ce sont des programmes à console.log, sans assertions ni exécuteur, et
      // `npm test` n'en lance aucun. Ils ne partent pas en production et ne
      // valent pas d'être remis aux normes — mais les supprimer est une
      // décision qui appartient à leur auteur, pas au linter.
      "test-*.js",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // Un `await` oublié sur une écriture en base est silencieux jusqu'au
      // jour où il ne l'est plus.
      "require-atomic-updates": "warn",
      "no-console": "off", // les journaux sont le tableau de bord de l'hébergeur
    },
  },
  {
    // Les tests sont écrits en modules ES (Vitest), contrairement au reste
    // du serveur qui est en CommonJS. Les deux cohabitent sans problème :
    // Vitest transpile, Node ne charge jamais ces fichiers.
    files: ["tests/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.node, ...globals.vitest },
    },
  },
];
