"use strict";

const cds = require("@sap/cds");

const process = require("process");
const helper = require("./helper");
const core = require("@actions/core");

const COMPONENT_NAME = "/TestEnv/Hana/Deploy";

(async () => {
  const logger = cds.log(COMPONENT_NAME);
  const testFiles = helper.findTestFiles();

  try {
    const schemaGuids = testFiles.reduce((result, fileName) => {
      result[fileName] = cds.utils.uuid().replace(/-/g, "_");
      return result;
    }, {});
    core.setOutput("schemaGuids", JSON.stringify(schemaGuids));

    for (const schemaGuid of Object.values(schemaGuids)) {
      logger.info("Loading csn");
      const csn = await cds.load("*");
      const credentials = await helper.prepareTestSchema(schemaGuid);
      cds.env.requires.db = {
        kind: "hana",
        impl: "@cap-js/hana",
        credentials,
      };
      await cds.connect.to("db");
      logger.info("Preparing test schema");
      await helper.deployToHana(csn);
      logger.info("Schema setup complete");
      process.exit(0);
    }
  } catch (error) {
    logger.error(error);
    process.exit(-1);
  }
})();
