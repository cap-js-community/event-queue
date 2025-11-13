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

    this.on("returnPlainStatus", (req) => {
      return req.data.status;
    });

    this.on("returnStatusAsArray", (req) => {
      return [[req.eventQueue.queueEntries[0].ID, req.data.status]];
    });

    this.on("rejectEvent", (req) => {
      req.reject(404, "error occured");
    });

    this.on("errorEvent", (req) => {
      req.error(404, "error occured");
    });
  }
}

module.exports = NotificationService;
