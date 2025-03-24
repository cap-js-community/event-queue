"use strict";

const cds = require("@sap/cds");

class NotificationServicePeriodic extends cds.Service {
  async init() {
    await super.init();
    this.on("main", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        eventQueueId: req.eventQueue.processor.eventSubType,
      });
    });

    this.on("action", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        eventQueueId: req.eventQueue.processor.eventSubType,
      });
    });
  }
}

module.exports = NotificationServicePeriodic;
