"use strict";

module.exports = {
  testTimeout: 600000,
  globalSetup: "./jest.globalSetup.js",

  modulePathIgnorePatterns: [
    "<rootDir>/gen",
    "<rootDir>/test-integration/_env/gen",
    "<rootDir>/test-integration/_env/node_modules",
  ],

  watchPathIgnorePatterns: [
    "<rootDir>/gen",
    "<rootDir>/test-integration/_env/gen",
    "<rootDir>/test-integration/_env/node_modules",
  ],

  projects: [
    {
      displayName: "unit",
      testMatch: ["<rootDir>/test/**/*.test.js"],
      testEnvironment: "node",
      setupFilesAfterEnv: ["<rootDir>/jest.setupAfterEnv.js"],
    },
    {
      displayName: "integration",
      testMatch: ["<rootDir>/test-integration/**/*.test.js"],
      testEnvironment: "node",
      setupFilesAfterEnv: ["<rootDir>/jest.setupAfterEnv.js"],
    },
  ],
};
