"use strict";

const EventQueueBaseClass = require("../../src/EventQueueProcessorBase");

class EventQueueHealthCheckDb extends EventQueueBaseClass {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  async processPeriodicEvent(processContext, key) {
    await this.getTxForEventProcessing(key).run(SELECT.from("sap.eventqueue.Event"));
  }
}

module.exports = EventQueueHealthCheckDb;
