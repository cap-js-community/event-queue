"use strict";

const cds = require("@sap/cds");

class StandardService extends cds.Service {
  async init() {
    await super.init();
    this.on("main", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
    });

    this.on("timeBucketAction", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
    });

    this.on("plainStatus", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });

      return 3;
    });

    this.on("statusViaObject", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });

      return { status: 3 };
    });

    this.on("startAfterAndStatusViaObject", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });

      return { status: 3, startAfter: new Date(Date.now() + 10 * 60 * 1000) };
    });

    this.on("startAfterAndStatusViaArray", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });

      return req.eventQueue.queueEntries.map(({ ID }) => [ID, { startAfter: new Date(Date.now() + 10 * 60 * 1000) }]);
    });

    this.on("startAfterAndStatusViaObjectArray", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });

      return req.eventQueue.queueEntries.map(({ ID }) => ({
        ID,
        status: 3,
        startAfter: new Date(Date.now() + 10 * 60 * 1000),
      }));
    });
  }
}

module.exports = StandardService;
