"use strict";

const { promisify } = require("util");

const cds = require("@sap/cds");

module.exports = class TaskService extends cds.Service {
  async init() {
    await super.init();

    this.on("process", async function (req) {
      const logger = cds.log(this.name);
      logger.info("starting processing task...", {
        ID: req.data.ID,
      });
      await promisify(setTimeout)(15 * 1000);
      const mailService = await cds.connect.to("mail-service");
      const task = await SELECT.one.from("sap.eventqueue.sample.Task").where({ ID: req.data.ID });
      await mailService.tx(req).emit("sendSingle", {
        to: req.user.id,
        subject: `Processing of task: '${task.description}' done.`,
      });
      await UPDATE.entity("sap.eventqueue.sample.Task").set({ status: "done" }).where({ ID: req.data.ID });
      logger.info("task processed", {
        ID: req.data.ID,
      });
    });

    this.on("syncJobs", async function () {
      const logger = cds.log(this.name);
      const task = await SELECT.one.from("sap.eventqueue.sample.Task").columns("count(ID) as count");
      logger.info("syncing jobs in periodic action...", { numberOfTasks: task.count });
    });
  }
};
