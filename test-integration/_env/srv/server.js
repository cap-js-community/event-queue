"use strict";

const cds = require("@sap/cds");
const { generateCredentialsForCds } = require("./hana/helper");

let credentials = JSON.parse(process.env.HANA_DB_CREDENTIALS || null);
try {
  if (process.env.NODE_ENV === "githubAction-hana") {
    if (!process.env.SCHEMA_GUID) {
      cds.log("/server").error("missing schema guid");
      process.exit(-1);
    }
    credentials = generateCredentialsForCds(process.env.SCHEMA_GUID);
  } else {
    credentials = require("../default-env").VCAP_SERVICES.hana[0].credentials;
  }
} catch {
  // Nothing to do
}

cds.log("/server").info("running on hana schema: ", credentials.schema);
cds.env.requires.db = {
  kind: "hana",
  credentials,
};

module.exports = cds.server;
