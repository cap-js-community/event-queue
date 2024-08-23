"use strict";

const cds = require("@sap/cds");

const process = require("process");
const helper = require("./helper");

const COMPONENT_NAME = "/TestEnv/Hana/Deploy";

(async () => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    const schemaGuid = process.env.SCHEMA_GUID?.replace(/-/g, "_");
    if (!schemaGuid) {
      logger.error("process.env.SCHEMA_GUID not provided!");
      process.exit(-1);
    }
    await helper.deleteTestSchema(schemaGuid);
    process.exit(0);
  } catch (error) {
    logger.error(error);
    process.exit(-1);
  }
})();
