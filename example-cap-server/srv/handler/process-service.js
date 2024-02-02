"use strict";

const cds = require("@sap/cds");

module.exports = class ProcessService extends cds.ApplicationService {
  async init() {
    await super.init();

    this.on("process", async (req) => {
      const task = await req.query;
      if (!task.length) {
        req.reject("task does not exist");
      }
      const srv = await cds.connect.to("task-service");
      await srv.emit("process", { ID: req.params[0] });
      debugger;
    });
  }
};
