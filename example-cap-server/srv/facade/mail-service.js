"use strict";

const cds = require("@sap/cds");
const eventQueue = require("@cap-js-community/event-queue");

module.exports = class MailService extends cds.Service {
  async init() {
    await super.init();

    this.on("sendSingle", async function (req) {
      await eventQueue.publishEvent(cds.tx(req), {
        type: "Mail",
        subType: "Single",
        payload: JSON.stringify(req.data),
      });
    });
  }
};
