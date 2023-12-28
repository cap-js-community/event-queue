"use strict";

const path = require("path");
const fs = require("fs").promises;
const packageJson = require("../package.json");

(async () => {
  packageJson.devDependencies["@cap-js/sqlite"] = "*";
  packageJson.devDependencies["@cap-js/hana"] = "*";
  await fs.writeFile(path.join(process.cwd(), "package.json"), JSON.stringify(packageJson));
})();
