"use strict";

const js = require("@eslint/js");
const globals = require("globals");
const jest = require("eslint-plugin-jest");
const prettier = require("eslint-config-prettier");

module.exports = [
  {
    ignores: ["node_modules/", "temp/", "docs/vendor/", "docs/_site/", "**/*.d.ts"],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        sap: "readonly",
        cds: "readonly",
        SELECT: "readonly",
        INSERT: "readonly",
        UPDATE: "readonly",
        DELETE: "readonly",
        CREATE: "readonly",
        DROP: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "req|res|next", caughtErrors: "none" }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-console": "error",
      "no-throw-literal": "error",
      "prefer-promise-reject-errors": "error",
      strict: "error",
      curly: "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-var": "error",
    },
  },
  {
    files: ["**/test/**", "**/test-integration/**", "**/*.test.js", "**/jest.setup*.js"],
    ...jest.configs["flat/recommended"],
  },
  prettier,
];
