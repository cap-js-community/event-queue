"use strict";

const cds = require("@sap/cds");

module.exports = class ProcessService extends cds.ApplicationService {
  async init() {
    await super.init();

    this.on("trigger", async (req) => {
      const task = await req.query;
      if (!task.length) {
        req.reject(404, "task does not exist");
      }

      if (task[0].status === "done") {
        req.reject(422, "task already processed");
      }

      const srv = await cds.connect.to("task-service");
      await srv.tx(req).send("process", req.params[0]);
      await UPDATE.entity("sap.eventqueue.sample.Task").set({ status: "in progress" }).where(req.params[0]);
    });

    this.on("triggerSpecial", async (req) => {
      const task = await req.query;
      if (!task.length) {
        req.reject(404, "task does not exist");
      }

      if (task[0].status === "done") {
        req.reject(422, "task already processed");
      }

      const srv = await cds.connect.to("task-service");
      await srv.tx(req).send("processSpecial", req.params[0]);
      await UPDATE.entity("sap.eventqueue.sample.Task").set({ status: "in progress" }).where(req.params[0]);
    });
  }
};
