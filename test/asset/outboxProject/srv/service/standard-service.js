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
  }
}

module.exports = StandardService;
