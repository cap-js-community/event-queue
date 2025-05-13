"use strict";

const cds = require("@sap/cds");

module.exports = class MonitoringService extends cds.ApplicationService {
  async init() {
    await super.init();

    this.on("restartProcessing", async (req) => {
      cds.log("eventQueue").info("Restarting processing for event queue");
    });
  }
};
