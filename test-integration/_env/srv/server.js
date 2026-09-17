"use strict";

const cds = require("@sap/cds");

if (cds.env.requires.db.kind === "postgres" && process.env.POSTGRES_SCHEMAS) {
  // eslint-disable-next-line jest/no-standalone-expect
  const schema = JSON.parse(process.env.POSTGRES_SCHEMAS)[expect.getState().testPath.split("/").pop()];
  if (!schema) {
    cds.log("/server").error("missing postgres schema");
    process.exit(-1);
  }
  cds.env.requires.db.credentials = { ...cds.env.requires.db.credentials, schema };
}

if (cds.env.requires.db.kind === "hana") {
  const { generateCredentialsForCds } = require("./hana/helper");

  let credentials = JSON.parse(process.env.HANA_DB_CREDENTIALS || null);
  try {
    if (process.env.GITHUB_ACTION_HANA) {
      if (!process.env.SCHEMA_GUIDS) {
        cds.log("/server").error("missing schema guid");
        process.exit(-1);
      }
      // eslint-disable-next-line jest/no-standalone-expect
      const schemaGuid = JSON.parse(process.env.SCHEMA_GUIDS)[expect.getState().testPath.split("/").pop()];
      credentials = generateCredentialsForCds(schemaGuid);
    } else {
      credentials = require("../default-env").VCAP_SERVICES.hana[0].credentials;
    }
  } catch {
    // Nothing to do
  }

  cds.env.requires.db.credentials = credentials;
}

module.exports = cds.server;
