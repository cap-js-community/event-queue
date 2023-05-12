"use strict";

const EventQueueBaseClass = require("../../src/EventQueueProcessorBase");
const { Logger } = require("../../src/shared/logger");
const { EventProcessingStatus } = require("../../src/constants");

const COMPONENT_NAME = "EventQueueTest";

class EventQueueTest extends EventQueueBaseClass {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
    this.__logger = Logger(context, COMPONENT_NAME);
  }

  async processEvent(processContext, key, queueEntries, payload) {
    return queueEntries.map((queueEntry) => [
      queueEntry.ID,
      EventProcessingStatus.Done,
    ]);
  }
}

module.exports = EventQueueTest;
