"use strict";

const cds = require("@sap/cds");
const cdsServe = require("@sap/cds/bin/serve");
const TENANTS = ["t1", "t2", "t3"];

const LOGGER = cds.log("/server");

(async function () {
  await cdsServe([], { port: "0" });
  await subscribeTenants();
  process.exit(0);
})();

async function subscribeTenants() {
  LOGGER.info("Setup of tenants started - Some more patience...");
  const ds = await cds.connect.to("cds.xt.DeploymentService");
  for (const tenant of TENANTS) {
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
