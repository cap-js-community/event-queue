"use strict";

const cds = require("@sap/cds");

const runEventCombinationForTenant = require("../runEventCombinationForTenant");

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
    setTimeout(() => {
      delete this.#scheduledEvents[key];
      runEventCombinationForTenant(tenantId, type, subType).catch((err) => {
        cds.log(COMPONENT_NAME).error("could not execute scheduled event", err, {
          tenantId,
          type,
          subType,
          scheduledFor: roundUpDate.toISOString(),
        });
      });
    }, secondsUntilNextTen * 1000).unref();
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
