"use strict";

const cds = require("@sap/cds");

const helper = require("./helper");

const COMPONENT_NAME = "/TestEnv/Hana/Deploy";

(async () => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    const schemaGuids = Object.values(JSON.parse(process.env.SCHEMA_GUIDS));
    const hanaAdminService = await helper.createAdminHANAService(cds.load("*"));
    for (const schemaGuid of schemaGuids) {
      await helper.deleteTestSchema(hanaAdminService, schemaGuid);
      process.exit(0);
    }
    await hanaAdminService.disconnect();
  } catch (error) {
    logger.error(error);
    process.exit(-1);
  }
})();
