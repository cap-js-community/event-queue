"use strict";

const cds = require("@sap/cds");

const fs = require("fs");
const os = require("os");
const process = require("process");
const helper = require("./helper");
const HanaService = require("@cap-js/hana/lib/HANAService");

const COMPONENT_NAME = "/TestEnv/Hana/Deploy";

const setActionOutput = (name, value) => {
  const filePath = process.env.GITHUB_OUTPUT;
  if (!filePath) {
    return;
  }
  const delimiter = `ghadelimiter_${cds.utils.uuid()}`;
  fs.appendFileSync(filePath, `${name}<<${delimiter}${os.EOL}${value}${os.EOL}${delimiter}${os.EOL}`);
};

(async () => {
  const logger = cds.log(COMPONENT_NAME);
  const testFiles = helper.findTestFiles();

  try {
    const schemaGuids = testFiles.reduce((result, fileName) => {
      result[fileName] = cds.utils.uuid().replace(/-/g, "_").toUpperCase();
      return result;
    }, {});
    setActionOutput("schemaGuids", JSON.stringify(schemaGuids));

    logger.info("Loading csn");
    const csn = await cds.load("*");
    const hanaAdminService = await helper.createAdminHANAService(csn);
    await Promise.all(
      Object.values(schemaGuids).map(async (schemaGuid) => {
        const credentials = await helper.prepareTestSchema(hanaAdminService, schemaGuid);
        logger.info("Preparing test schema");
        const hanaService = new HanaService(`db-${schemaGuid}`, csn, {
          kind: "hana",
          impl: "@cap-js/hana",
          credentials,
        });
        await hanaService.init();
        await helper.deployToHana(hanaService, csn);
        await hanaService.disconnect();
        logger.info("Schema setup complete");
      })
    );
    await hanaAdminService.disconnect();
    process.exit(0);
  } catch (error) {
    logger.error(error);
    process.exit(-1);
  }
})();
