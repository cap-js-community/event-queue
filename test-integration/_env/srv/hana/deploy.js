"use strict";

const cds = require("@sap/cds");

const process = require("process");
const helper = require("./helper");

const COMPONENT_NAME = "/TestEnv/Hana/Deploy";

(async () => {
  const logger = cds.log(COMPONENT_NAME);
  const schemaGuid = process.env.SCHEMA_GUID?.replace(/-/g, "_");
  if (!schemaGuid) {
    logger.error("process.env.SCHEMA_GUID not provided!");
    process.exit(-1);
  }
  logger.info("Loading csn");
  const csn = await cds.load("*");
  try {
    await helper.prepareHana();
    const credentials = await helper.prepareTestSchema(schemaGuid);
    cds.env.requires.db = {
      kind: "hana",
      credentials,
    };
    logger.info("db settings", {
      kind: cds.env.requires.db.kind,
      impl: cds.env.requires.db.impl,
    });
    await cds.connect.to("db");
    logger.info("Preparing test schema");
    await helper.deployToHana(csn);
    logger.info("Schema setup complete");
    process.exit(0);
  } catch (error) {
    logger.error(error);
    process.exit(-1);
  }
})();
