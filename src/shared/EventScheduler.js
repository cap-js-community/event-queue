"use strict";

const cds = require("@sap/cds");

const { broadcastEvent } = require("../redisPubSub");
const config = require("./../config");

const COMPONENT_NAME = "eventQueue/shared/EventScheduler";

let instance;
class EventScheduler {
  #scheduledEvents = {};
  constructor() {}

  scheduleEvent(tenantId, type, subType, startAfter) {
    const configInstance = config.getConfigInstance();
    const eventConfig = configInstance.getEventConfig(type, subType);
    const scheduleWithoutDelay = configInstance.isPeriodicEvent(type, subType) && eventConfig.interval < 30 * 1000;
    const roundUpDate = scheduleWithoutDelay ? startAfter : this.calculateFutureTime(startAfter, 10);
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

  calculateFutureTime(date, seoncds) {
    const startAfterSeconds = date.getSeconds();
    const secondsUntil = seoncds - (startAfterSeconds % seoncds);
    return new Date(date.getTime() + secondsUntil * 1000);
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
