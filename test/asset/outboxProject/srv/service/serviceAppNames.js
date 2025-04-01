"use strict";

const cds = require("@sap/cds");

const ACTION = ["appNamesRegex", "appNamesString", "appNamesMixStringMatch"];

class ServiceAppNames extends cds.Service {
  async init() {
    await super.init();

    for (const actionName of ACTION) {
      this.on(actionName, (req) => {
        cds.log(this.name).info(req.event, {
          data: req.data,
          user: req.user.id,
          subType: req.eventQueue.processor.eventSubType,
        });
      });
    }
  }
}

module.exports = ServiceAppNames;
