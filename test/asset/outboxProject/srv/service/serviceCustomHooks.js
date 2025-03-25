"use strict";

const cds = require("@sap/cds");

class OutboxCustomHooks extends cds.Service {
  async init() {
    await super.init();
    this.on("main", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
    });

    this.on("action", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
    });

    this.on("clusterQueueEntries", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByEventProperty("ID");
    });

    this.on("clusterQueueEntries.action", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByPayloadProperty("to", (accumulatorPayload, data) => {
        accumulatorPayload.to += data.to;
      });
    });

    this.on("checkEventAndGeneratePayload", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
      return req.data;
    });

    this.on("checkEventAndGeneratePayload.action", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
      req.data.to = "newValue";
      return req.data;
    });
  }
}

module.exports = OutboxCustomHooks;
