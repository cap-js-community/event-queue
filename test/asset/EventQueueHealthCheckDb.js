"use strict";

const EventQueueBaseClass = require("../../src/EventQueueProcessorBase");

class EventQueueHealthCheckDb extends EventQueueBaseClass {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  // eslint-disable-next-line no-unused-vars
  async processPeriodicEvent(processContext, key) {
    await this.getTxForEventProcessing(key).run(SELECT.from("sap.eventqueue.Event"));
  }
}

module.exports = EventQueueHealthCheckDb;
