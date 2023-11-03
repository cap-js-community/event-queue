"use strict";

// https://eslint.org/docs/rules/
module.exports = {
  root: true,
  env: {
    node: true,
    es2020: true,
  },
  parserOptions: {
    ecmaVersion: 13,
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
  plugins: ["jest", "node"],
  extends: ["eslint:recommended", "plugin:jest/recommended", "prettier"],
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
