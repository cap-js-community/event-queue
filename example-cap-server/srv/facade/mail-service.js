"use strict";

const cds = require("@sap/cds");

module.exports = class MailService extends cds.Service {
  async init() {
    await super.init();

    this.on("sendSingle", async function (req) {
      this.logger.info("sending e-mail", req.data);
    });
  }
};
