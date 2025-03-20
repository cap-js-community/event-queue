"use strict";

const cds = require("@sap/cds");

class NotificationServicePeriodic extends cds.Service {
  async init() {
    await super.init();
    this.on("main", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        eventQueueId: req.context._eventQueue?.queueEntries[0].subType,
      });
    });

    this.on("action", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        eventQueueId: req.context._eventQueue?.queueEntries[0].subType,
      });
    });
  }
}

module.exports = NotificationServicePeriodic;
