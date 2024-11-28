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
    this.#eventsByTenants[tenantId] ??= {};
    const timeout = setTimeout(() => {
      // NOTE: needed due to a bug in node.js which is leaking memory; will be fixed in v22.4.0
      // https://github.com/nodejs/node/pull/53337/files
      clearTimeout(timeout);
      delete this.#eventsByTenants[tenantId][timeout];
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
    this.#eventsByTenants[tenantId][timeout] = true;
  }

  clearForTenant(tenantId) {
    Object.keys(this.#eventsByTenants[tenantId] ?? []).forEach((timeoutId) => clearTimeout(timeoutId));
  }

  calculateOffset(type, subType, startAfter) {
    const date = startAfter;
    return { date, relative: date.getTime() - Date.now() };
  }

  clearScheduledEvents() {
    this.#scheduledEvents = {};
  }

  clearEventsByTenants() {
    this.#eventsByTenants = {};
  }

  get eventsByTenants() {
    return this.#eventsByTenants;
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
