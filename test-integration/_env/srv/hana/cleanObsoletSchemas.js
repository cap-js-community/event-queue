"use strict";

const cds = require("@sap/cds");

const process = require("process");
const helper = require("./helper");

const COMPONENT_NAME = "/TestEnv/Hana/Deploy";

(async () => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    await helper.deleteExistingSchema();
    process.exit(0);
  } catch (error) {
    logger.error(error);
    process.exit(-1);
  }
})();
