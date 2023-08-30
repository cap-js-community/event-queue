"use strict";

const { promisify } = require("util");

const eventQueue = require("@cap-js-community/event-queue");

class EventQueueCryptoHash extends eventQueue.EventQueueProcessorBase {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  async processEvent(processContext, key, queueEntries, payload) {
    this.logger.info("calculating hash", payload);
    await promisify(setTimeout)(payload.duration);
    return queueEntries.map((queueEntry) => [queueEntry.ID, eventQueue.EventProcessingStatus.Done]);
  }
}

module.exports = EventQueueCryptoHash;
