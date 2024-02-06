"use strict";

const { promisify } = require("util");
const eventQueue = require("@cap-js-community/event-queue");

class EventQueueMail extends eventQueue.EventQueueProcessorBase {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  // eslint-disable-next-line no-unused-vars
  async processPeriodicEvent(processContext, key, queueEntry) {
    const timestampLastRun = await this.getLastSuccessfulRunTimestamp();
    await promisify(setTimeout)(2000);
    this.logger.info("doing db health check...", {
      id: queueEntry.ID,
      timestampLastRun,
      now: new Date().toISOString(),
    });
  }
}

module.exports = EventQueueMail;
