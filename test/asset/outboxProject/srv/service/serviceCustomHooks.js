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

    this.on("clusterQueueEntries.actionClusterByDataWithCb", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByDataProperty("to", (clusterKey, entries) => {
        return { ...entries[0], guids: entries.map((a) => a.guids).flat() };
      });
    });

    this.on("clusterQueueEntries", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByPayloadProperty("data.to");
    });

    this.on("clusterQueueEntries.actionClusterByPayloadWithCb", (req) => {
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
      return req.eventQueue.clusterByEventProperty("referenceEntityKey", (clusterKey, entries) => {
        return { ...entries[0], guids: entries.map((a) => a.guids).flat() };
      });
    });

    this.on("clusterQueueEntries.actionClusterByEventWithoutCb", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return req.eventQueue.clusterByEventProperty("referenceEntityKey");
    });

    this.on("clusterQueueEntries.actionWithInvalidClusterReturn", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      return [];
    });

    this.on("clusterQueueEntries.throwErrorInCluster", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
      throw new Error("cluster error");
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

    this.on("hookForExceededEvents", async (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
      await cds.outboxed(this).tx(req).send("action");
    });

    this.on("hookForExceededEvents.exceededActionSpecific", async (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
      await cds.outboxed(this).tx(req).send("action");
    });

    this.on("hookForExceededEvents.exceededActionSpecificMixed", async (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
      await cds.outboxed(this).tx(req).send("action");
    });

    this.on("hookForExceededEvents.exceededActionSpecificError", async (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        subType: req.eventQueue.processor.eventSubType,
      });
      await INSERT.into("sap.eventqueue.Lock").entries({ code: "DummyTest" });
      throw new Error("all bad");
    });

    this.on("hookForExceededEvents.exceededActionWithCommit", async (req) => {
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
