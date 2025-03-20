"use strict";

const cds = require("@sap/cds");

const helper = require("./helper");

const COMPONENT_NAME = "/TestEnv/Hana/Deploy";

(async () => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    const schemaGuids = Object.values(JSON.parse(process.env.SCHEMA_GUIDS));
    const hanaAdminService = await helper.createAdminHANAService(cds.load("*"));
    await Promise.all(schemaGuids.map((schemaGuid) => helper.deleteTestSchema(hanaAdminService, schemaGuid)));
    await hanaAdminService.disconnect();
    process.exit(0);
  } catch (error) {
    logger.error(error);
    process.exit(-1);
  }
})();
