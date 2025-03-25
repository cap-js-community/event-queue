"use strict";

const cds = require("@sap/cds");

const CLUSTER_ACTIONS = [
  "action",
  "actionClusterByPayloadWithCb",
  "actionClusterByPayloadWithoutCb",
  "actionClusterByEventWithCb",
  "actionClusterByEventWithoutCb",
  "actionClusterByData",
];

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

    for (const actionName of CLUSTER_ACTIONS) {
      this.on(actionName, (req) => {
        cds.log(this.name).info(req.event, {
          data: req.data,
          user: req.user.id,
          subType: req.eventQueue.processor.eventSubType,
        });
      });
    }

    this.on("clusterQueueEntries.action", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByPayloadProperty("event");
    });

    this.on("clusterQueueEntries.actionClusterByData", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByPayloadProperty("data.to");
    });

    this.on("clusterQueueEntries", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByEventProperty("ID");
    });

    this.on("clusterQueueEntries.actionClusterByPayloadWithCb", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByPayloadProperty("data.to", (accumulatorPayload, data, index) => {
        if (!index) {
          accumulatorPayload.guids = [];
        }
        accumulatorPayload.guids = accumulatorPayload.guids.concat(data.guids);
      });
    });

    this.on("clusterQueueEntries.actionClusterByPayloadWithoutCb", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByPayloadProperty("data.to");
    });

    this.on("clusterQueueEntries.actionClusterByEventWithCb", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByEventProperty("referenceEntityKey", (accumulatorPayload, data, index) => {
        if (!index) {
          accumulatorPayload.guids = [];
        }
        accumulatorPayload.guids = accumulatorPayload.guids.concat(data.guids);
      });
    });

    this.on("clusterQueueEntries.actionClusterByEventWithoutCb", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByEventProperty("referenceEntityKey");
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
