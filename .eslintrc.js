"use strict";

const path = require("path");

// https://eslint.org/docs/rules/
module.exports = {
  root: true,
  env: {
    node: true,
    es2020: true,
  },
  parserOptions: {
    ecmaVersion: 2020,
  },
  globals: {
    sap: false,
    cds: false,
    SELECT: false,
    INSERT: false,
    UPDATE: false,
    DELETE: false,
    CREATE: false,
    DROP: false,
  },
  plugins: ["jest", "custom-lint-rules", "node"],
  extends: [
    "eslint:recommended",
    "plugin:jest/recommended",
    "plugin:@sap/cds/recommended",
    "prettier",
  ],
  rules: {
    "no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "req|res|next",
      },
    ],
    "no-eval": ["error"], // security
    "no-implied-eval": ["error"], // security
    "no-console": ["error"], // ops
    "no-throw-literal": ["error"],
    "prefer-promise-reject-errors": ["error"],
    strict: ["error"],
    curly: ["error"],
    "no-constant-condition": [
      "error",
      {
        checkLoops: false,
      },
    ],
    "no-var": ["error"],
  },
};
