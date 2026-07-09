"use strict";

const cds = require("@sap/cds");

if (!process.env.HANA_DB_CREDENTIALS) {
  try {
    process.env.HANA_DB_CREDENTIALS = JSON.stringify(require("../default-env").VCAP_SERVICES.hana[0].credentials);
  } catch {
    // Nothing to do
  }
}

let credentials = JSON.parse(process.env.HANA_DB_CREDENTIALS || null);

const { generateCredentialsForCds } = require("./hana/helper");

if (process.env.GITHUB_ACTION_HANA) {
  if (!process.env.SCHEMA_GUIDS) {
    cds.log("/server").error("missing schema guid");
    process.exit(-1);
  }
  // eslint-disable-next-line jest/no-standalone-expect
  const schemaGuid = JSON.parse(process.env.SCHEMA_GUIDS)[expect.getState().testPath.split("/").pop()];
  credentials = generateCredentialsForCds(schemaGuid);
}

cds.env.requires.db.credentials = credentials;

module.exports = cds.server;
