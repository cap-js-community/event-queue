"use strict";

const cds = require("@sap/cds");

class StandardService extends cds.Service {
  async init() {
    await super.init();
    this.on("saga", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return {
        status: req.data.status ?? 2,
        ...(req.data.nextData && { nextData: req.data.nextData }),
        ...(req.data.errorMessage && { error: new Error(req.data.errorMessage) }),
      };
    });

    this.on("saga/#succeeded", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return {
        status: req.data.status ?? 2,
        ...(req.data.errorMessage && { error: new Error(req.data.errorMessage) }),
      };
    });

    this.on("saga/#failed", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return {
        status: 2,
        ...(req.data.errorMessage && { error: new Error(req.data.errorMessage) }),
      };
    });
  }
}

module.exports = StandardService;
