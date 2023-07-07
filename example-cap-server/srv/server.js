"use strict";

const cds = require("@sap/cds");

const LOGGER = cds.log("/server");

cds.on("loaded", (csn) => {
  // FIXME: https://github.tools.sap/cap/issues/issues/13936
  if (csn.definitions["sap.eventqueue.Event"]) {
    cds.db.model = csn;
  }
});

cds.on("listening", () => {
  subscribeTenants().catch(LOGGER);
});

async function subscribeTenants() {
  LOGGER.info("Setup of tenants started - Some more patience...");
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

  LOGGER.info("Setup of tenants finished - You can start testing now!");
}

module.exports = cds.server;
