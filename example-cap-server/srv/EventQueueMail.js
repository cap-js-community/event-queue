"use strict";

const eventQueue = require("@cap-js-community/event-queue");

class EventQueueMail extends eventQueue.EventQueueProcessorBase {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  async processEvent(processContext, key, queueEntries, payload) {
    this.logger.info("sending e-mail", payload);
    return queueEntries.map((queueEntry) => [queueEntry.ID, eventQueue.EventProcessingStatus.Done]);
  }
}

module.exports = EventQueueMail;
