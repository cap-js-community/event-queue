"use strict";

const cds = require("@sap/cds");

const LOGGER = cds.log("/server");

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

  setTimeout(() => {
    LOGGER.info("onboarding another tenant...");
    ds.subscribe("t3").then(() => {
      LOGGER.info("done...");
    });
  }, 15 * 1000);

  LOGGER.info("Setup of tenants finished - You can start testing now!");
}

module.exports = cds.server;
