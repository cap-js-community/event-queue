"use strict";

const cds = require("@sap/cds");

class NotificationService extends cds.Service {
  async init() {
    await super.init();
    this.on("sendFiori", (req) => {
      cds.log("sendFiori").info("sendFiori action triggered");
    });

    this.on("sendEmail", (req) => {
      cds.log("sendEmail").info("sendEmail action triggered");
    });
  }
}

module.exports = NotificationService;
