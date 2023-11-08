"use strict";

const cds = require("@sap/cds");
const { generateCredentialsForCds } = require("./hana/helper");

let credentials = JSON.parse(process.env.HANA_DB_CREDENTIALS || null);
try {
  if (process.env.NODE_ENV === "local-hana") {
    credentials = require("../db/default-env").VCAP_SERVICES.hana[0].credentials;
  } else if (process.env.NODE_ENV === "githubAction-hana") {
    credentials = generateCredentialsForCds();
  }
} catch {
  // Nothing to do
}

cds.env.requires.db = {
  kind: "hana",
  credentials,
};

module.exports = cds.server;
