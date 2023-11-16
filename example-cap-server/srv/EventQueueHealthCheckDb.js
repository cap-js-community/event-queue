"use strict";

const eventQueue = require("@cap-js-community/event-queue");

class EventQueueMail extends eventQueue.EventQueueProcessorBase {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  // eslint-disable-next-line no-unused-vars
  async processPeriodicEvent(processContext, key, queueEntry) {
    this.logger.info("doing db health check...", {
      id: queueEntry.ID,
      now: new Date().toISOString(),
    });
  }
}

module.exports = EventQueueMail;
