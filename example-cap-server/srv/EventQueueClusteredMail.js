"use strict";

const eventQueue = require("@cap-js-community/event-queue");

class EventQueueMail extends eventQueue.EventQueueProcessorBase {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  clusterQueueEntries(queueEntriesWithPayloadMap) {
    Object.entries(queueEntriesWithPayloadMap).forEach(([, { queueEntry, payload }]) => {
      const key = [payload.to, payload.notificationCode].join("##");
      this.addEntryToProcessingMap(key, queueEntry, payload);
    });
  }

  async processEvent(processContext, key, queueEntries, payload) {
    this.logger.info(`sending e-mail - clustered - E-Mails in Batch: ${queueEntries.length}`, payload);
    return queueEntries.map((queueEntry) => [queueEntry.ID, eventQueue.EventProcessingStatus.Done]);
  }
}

module.exports = EventQueueMail;
