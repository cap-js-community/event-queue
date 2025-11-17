"use strict";

const cds = require("@sap/cds");

class NotificationService extends cds.Service {
  async init() {
    await super.init();
    this.on("sendFiori", (req) => {
      cds.log("sendFiori").info("sendFiori action triggered", {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue?.processor.eventSubType,
        headers: req.headers,
      });
    });

    this.on("rejectEvent", async (req) => {
      await INSERT.into("sap.eventqueue.Lock").entries({
        code: req.data.lockId,
      });
      req.reject(404, "error occurred");
    });

    this.on("errorEvent", (req) => {
      req.error(404, "error occurred");
    });
  }
}

module.exports = NotificationService;
