"use strict";

const cds = require("@sap/cds");

const { broadcastEvent } = require("../redisPubSub");

const COMPONENT_NAME = "eventQueue/shared/EventScheduler";

let instance;
class EventScheduler {
  #scheduledEvents = {};
  constructor() {}

  scheduleEvent(tenantId, type, subType, startAfter) {
    const startAfterSeconds = startAfter.getSeconds();
    const secondsUntilNextTen = 10 - (startAfterSeconds % 10);
    const roundUpDate = new Date(startAfter.getTime() + secondsUntilNextTen * 1000);
    const key = [tenantId, type, subType, roundUpDate.toISOString()].join("##");
    if (this.#scheduledEvents[key]) {
      return; // event combination already scheduled
    }
    this.#scheduledEvents[key] = true;
    cds.log(COMPONENT_NAME).info("scheduling event queue run for delayed event", {
      type,
      subType,
      delaySeconds: (roundUpDate.getTime() - Date.now()) / 1000,
    });
    setTimeout(() => {
      delete this.#scheduledEvents[key];
      broadcastEvent(tenantId, type, subType).catch((err) => {
        cds.log(COMPONENT_NAME).error("could not execute scheduled event", err, {
          tenantId,
          type,
          subType,
          scheduledFor: roundUpDate.toISOString(),
        });
      });
    }, roundUpDate.getTime() - Date.now()).unref();
  }

  clearScheduledEvents() {
    this.#scheduledEvents = {};
  }
}

module.exports = {
  getInstance: () => {
    if (!instance) {
      instance = new EventScheduler();
    }
    return instance;
  },
};
