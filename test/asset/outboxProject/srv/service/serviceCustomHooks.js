"use strict";

const cds = require("@sap/cds");

const ACTION = [
  "action",
  "main",
  "anotherAction",
  "actionClusterByPayloadWithCb",
  "actionClusterByPayloadWithoutCb",
  "actionClusterByEventWithCb",
  "actionClusterByDataWithCb",
  "actionClusterByEventWithoutCb",
  "actionClusterByData",
  "actionWithInvalidClusterReturn",
  "throwErrorInCluster",
];

class OutboxCustomHooks extends cds.Service {
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

    this.on("eventQueueCluster.action", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByPayloadProperty("event");
    });

    this.on("eventQueueCluster.actionClusterByData", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByPayloadProperty("data.to");
    });

    this.on("eventQueueCluster.actionClusterByDataWithCb", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByDataProperty("to", (clusterKey, entries) => {
        return { ...entries[0], guids: entries.map((a) => a.guids).flat() };
      });
    });

    this.on("eventQueueCluster", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByPayloadProperty("data.to");
    });

    this.on("eventQueueCluster.actionClusterByPayloadWithCb", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByPayloadProperty("data.to", (clusterKey, entries) => {
        cds.log(this.name).info("clusterKey", {
          clusterKey,
        });
        return { ...entries[0], guids: entries.map((a) => a.guids).flat() };
      });
    });

    this.on("eventQueueCluster.actionClusterByPayloadWithoutCb", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByPayloadProperty("data.to");
    });

    this.on("eventQueueCluster.actionClusterByEventWithCb", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByEventProperty("referenceEntityKey", (clusterKey, entries) => {
        return { ...entries[0], guids: entries.map((a) => a.guids).flat() };
      });
    });

    this.on("eventQueueCluster.actionClusterByEventWithoutCb", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByEventProperty("referenceEntityKey");
    });

    this.on("eventQueueCluster.actionWithInvalidClusterReturn", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return [];
    });

    this.on("eventQueueCluster.throwErrorInCluster", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      throw new Error("cluster error");
    });

    this.on("eventQueueCheckAndAdjustPayload", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
      return req.data;
    });

    this.on("eventQueueCheckAndAdjustPayload.action", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
      req.data.to = "newValue";
      return req.data;
    });

    this.on("exceededAction", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
      const [queueEntry] = req.eventQueue.queueEntries;
      if (!queueEntry.attempts) {
        throw new Error("retry!");
      }
    });

    this.on("exceededActionSpecific", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
      const [queueEntry] = req.eventQueue.queueEntries;
      if (!queueEntry.attempts) {
        throw new Error("retry!");
      }
    });

    this.on("eventQueueRetriesExceeded", async (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
      await cds.outboxed(this).tx(req).send("action");
    });

    this.on("eventQueueRetriesExceeded.exceededActionSpecific", async (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
      await cds.outboxed(this).tx(req).send("action");
    });

    this.on("eventQueueRetriesExceeded.exceededActionSpecificMixed", async (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
      await cds.outboxed(this).tx(req).send("action");
    });

    this.on("eventQueueRetriesExceeded.exceededActionSpecificError", async (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
      await INSERT.into("sap.eventqueue.Lock").entries({ code: "DummyTest" });
      throw new Error("all bad");
    });

    this.on("eventQueueRetriesExceeded.exceededActionWithCommit", async (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
      await INSERT.into("sap.eventqueue.Lock").entries({ code: "DummyTest" });
    });
  }
}

module.exports = OutboxCustomHooks;
