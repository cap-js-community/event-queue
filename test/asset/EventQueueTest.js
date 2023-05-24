"use strict";

const EventQueueBaseClass = require("../../src/EventQueueProcessorBase");
const { EventProcessingStatus } = require("../../src/constants");

const COMPONENT_NAME = "EventQueueTest";

class EventQueueTest extends EventQueueBaseClass {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  async processEvent(processContext, key, queueEntries, payload) {
    await this.getTxForEventProcessing(key).run(
      SELECT.from("sap.core.EventQueue")
    );
    return queueEntries.map((queueEntry) => [
      queueEntry.ID,
      EventProcessingStatus.Done,
    ]);
  }

  async checkEventAndGeneratePayload(queueEntry) {
    await this.tx.run(SELECT.from("sap.core.EventQueue"));
    return queueEntry;
  }
}

module.exports = EventQueueTest;
