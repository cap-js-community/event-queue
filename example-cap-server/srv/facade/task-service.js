"use strict";

const cds = require("@sap/cds");

module.exports = class TaskService extends cds.Service {
  async init() {
    await super.init();

    this.on("process", async (req) => {
      debugger;
    });
  }
};
