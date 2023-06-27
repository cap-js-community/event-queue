"use strict";

const cds = require("@sap/cds");
const { register } = require("./watchdogV2");

cds.on("listening", () => {
  cds.db.model = cds.model;
  register();
  subscribeTenants();
});

async function subscribeTenants() {
  cds.log("/server").info("Setup of tenants started - Some more patience...");
  const ds = await cds.connect.to("cds.xt.DeploymentService");
  const tenants = ["t1", "t2"];
  for (const tenant of tenants) {
    try {
      await ds.unsubscribe(tenant);
    } catch {
      /* does not exist */
    }
    await ds.subscribe(tenant);
  }
  cds
    .log("/server")
    .info("Setup of tenants finished - You can start testing now!");
}

module.exports = cds.server;
