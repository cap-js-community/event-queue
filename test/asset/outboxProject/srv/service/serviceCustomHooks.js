"use strict";

const cds = require("@sap/cds");

class OutboxCustomHooks extends cds.Service {
  async init() {
    await super.init();
    this.on("main", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.context._eventQueue?.queueEntries[0].subType,
      });
    });

    this.on("action", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.context._eventQueue?.queueEntries[0].subType,
      });
    });

    this.on("clusterQueueEntries", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return Object.entries(req.data.queueEntriesWithPayloadMap).reduce((result, [, { queueEntry, payload }]) => {
        result[payload.event] ??= {
          queueEntries: [],
          payload,
        };
        result[payload.event].queueEntries.push(queueEntry);
        return result;
      }, {});
    });

    this.on("clusterQueueEntries.action", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return Object.entries(req.data.queueEntriesWithPayloadMap).reduce((result, [, { queueEntry, payload }]) => {
        result[payload.event] ??= {
          queueEntries: [],
          payload,
        };
        result[payload.event].queueEntries.push(queueEntry);
        return result;
      }, {});
    });

    this.on("checkEventAndGeneratePayload", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.context._eventQueue?.queueEntries[0].subType,
      });
      return req.data;
    });

    this.on("checkEventAndGeneratePayload.action", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.context._eventQueue?.queueEntries[0].subType,
      });
      req.data.to = "newValue";
      return req.data;
    });
  }
}

module.exports = OutboxCustomHooks;
