"use strict";

const cds = require("@sap/cds");

const helper = require("./helper");

const COMPONENT_NAME = "/TestEnv/Hana/Deploy";

(async () => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    const schemaGuids = Object.values(JSON.parse(process.env.SCHEMA_GUIDS));

    for (const schemaGuid of schemaGuids) {
      await helper.deleteTestSchema(schemaGuid);
      process.exit(0);
    }
  } catch (error) {
    logger.error(error);
    process.exit(-1);
  }
})();
