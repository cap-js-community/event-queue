"use strict";

const cds = require("@sap/cds");
const { generateCredentialsForCds } = require("./hana/helper");

let credentials = JSON.parse(process.env.HANA_DB_CREDENTIALS || null);
try {
  if (process.env.GITHUB_ACTION_HANA) {
    if (!process.env.SCHEMA_GUID) {
      cds.log("/server").error("missing schema guid");
      process.exit(-1);
    }
    credentials = generateCredentialsForCds(process.env.SCHEMA_GUID?.replace(/-/g, "_"));
  } else {
    credentials = require("../default-env").VCAP_SERVICES.hana[0].credentials;
  }
} catch {
  // Nothing to do
}

cds.env.requires.db = {
  impl: /true/i.test(process.env.OLD_DB_SERVICE) ? "@sap/cds/libx/_runtime/hana/Service.js" : "@cap-js/hana",
  kind: "hana",
  credentials,
};

module.exports = cds.server;
