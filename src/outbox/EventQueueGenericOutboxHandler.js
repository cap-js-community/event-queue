"use strict";

const cds = require("@sap/cds");

const EventQueueBaseClass = require("../EventQueueProcessorBase");
const { EventProcessingStatus } = require("../constants");

const COMPONENT_NAME = "/eventQueue/outbox/generic";

class EventQueueGenericOutboxHandler extends EventQueueBaseClass {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
    this.logger = cds.log(`${COMPONENT_NAME}/${eventSubType}`);
  }

  async processEvent(processContext, key, queueEntries, payload) {
    let status = EventProcessingStatus.Done;
    try {
      const service = await cds.connect.to(this.eventSubType);
      const userId = payload.contextUser;
      const msg = payload._fromSend ? new cds.Request(payload) : new cds.Event(payload);
      const invocationFn = payload._fromSend ? "send" : "emit";
      delete msg._fromSend;
      delete msg.contextUser;
      processContext.user = new cds.User.Privileged(userId);
      await cds.unboxed(service).tx(processContext)[invocationFn](msg);
    } catch (err) {
      status = EventProcessingStatus.Error;
      this.logger.error("error processing outboxed service call", err, {
        serviceName: this.eventSubType,
      });
    }
    return queueEntries.map((queueEntry) => [queueEntry.ID, status]);
  }
}

module.exports = EventQueueGenericOutboxHandler;
