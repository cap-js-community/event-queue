"use strict";

const EventQueueBaseClass = require("../EventQueueProcessorBase");

const COMPONENT_NAME = "eventQueue/outbox/generic";

class EventQueueGenericOutboxHandler extends EventQueueBaseClass {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
    this.logger = cds.log(`${COMPONENT_NAME}/${eventSubType}`);
  }

  // eslint-disable-next-line no-unused-vars
  async processEvent(processContext, key, queueEntries, payload) {
    try {
      // eslint-disable-next-line no-unused-vars
      const service = await cds.connect.to(this.eventSubType);
      debugger;
    } catch (err) {
      //TODO: implement
    }
  }
}

module.exports = EventQueueGenericOutboxHandler;
