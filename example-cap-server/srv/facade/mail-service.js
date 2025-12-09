"use strict";

const cds = require("@sap/cds");

module.exports = class MailService extends cds.Service {
  async init() {
    await super.init();

    this.on("sendSingle", async function (req) {
      req.eventQueue.processor.logger.info("sending e-mail", req.data);
    });

    this.on("eventQueueCluster", async function (req) {
      return req.eventQueue.clusterByDataProperty("to", (clusterKey, entries) => {
        return {
          to: clusterKey,
          subjects: entries.map((entry) => entry.subject),
        };
      });
    });
  }
};
