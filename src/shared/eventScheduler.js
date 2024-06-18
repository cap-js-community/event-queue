"use strict";

const cds = require("@sap/cds");

const redisPub = require("../redis/redisPub");
const config = require("./../config");

const COMPONENT_NAME = "/eventQueue/shared/eventScheduler";

let instance;
class EventScheduler {
  #scheduledEvents = {};
  #eventsByTenants = {};
  constructor() {
    config.attachUnsubscribeHandler(this.clearForTenant.bind(this));
  }

  scheduleEvent(tenantId, type, subType, startAfter) {
    const { date, relative } = this.calculateOffset(type, subType, startAfter);
    const key = [tenantId, type, subType, date.toISOString()].join("##");
    if (this.#scheduledEvents[key]) {
      return; // event combination already scheduled
    }
    this.#scheduledEvents[key] = true;
    cds.log(COMPONENT_NAME).debug("scheduling event queue run for delayed event", {
      type,
      subType,
      delaySeconds: (date.getTime() - Date.now()) / 1000,
    });
    setTimeout(() => {
      delete this.#scheduledEvents[key];
      redisPub.broadcastEvent(tenantId, { type, subType }).catch((err) => {
        cds.log(COMPONENT_NAME).error("could not execute scheduled event", err, {
          tenantId,
          type,
          subType,
          scheduledFor: date.toISOString(),
        });
      });
    }, relative).unref();
  }

  clearForTenant() {}

  calculateOffset(type, subType, startAfter) {
    const eventConfig = config.getEventConfig(type, subType);
    const scheduleWithoutDelay = config.isPeriodicEvent(type, subType) && eventConfig.interval < 30 * 1000;
    const date = scheduleWithoutDelay ? startAfter : this.calculateFutureTime(startAfter, 10);

    return { date, relative: date.getTime() - Date.now() };
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
