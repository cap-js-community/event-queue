"use strict";

const path = require("path");

const { adjustJSON } = require("../../bin/common/util");

module.exports = async function () {
  const packageJson = require(path.join(process.cwd(), "../../../../../package.json"));
  adjustJSON("./webapp/manifest.json", (manifest) => {
    if (manifest["sap.app"]?.id && !manifest["sap.app"].id.startsWith(`${packageJson.name}.`)) {
      manifest["sap.app"] ??= {};
      manifest["sap.app"].id = `${packageJson.name}.${manifest["sap.app"].id}`;
    }
    if (!manifest?.["sap.cloud"]?.service) {
      const strippedAppName = packageJson.name.replace(/-/g, "");
      manifest["sap.cloud"] ??= {};
      manifest["sap.cloud"].service = `${strippedAppName}.service`;
    }
  });
};
