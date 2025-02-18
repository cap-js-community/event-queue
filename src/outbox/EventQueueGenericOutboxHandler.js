"use strict";

const cds = require("@sap/cds");

const EventQueueBaseClass = require("../EventQueueProcessorBase");
const { EventProcessingStatus } = require("../constants");
const common = require("../shared/common");
const config = require("../config");

const COMPONENT_NAME = "/eventQueue/outbox/generic";

class EventQueueGenericOutboxHandler extends EventQueueBaseClass {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
    this.logger = cds.log(`${COMPONENT_NAME}/${eventSubType}`);
  }

  async processEvent(processContext, key, queueEntries, payload) {
    try {
      const service = await cds.connect.to(this.eventSubType);
      const { useEventQueueUser } = this.eventConfig;
      const userId = useEventQueueUser ? config.userId : payload.contextUser;
      const msg = payload._fromSend ? new cds.Request(payload) : new cds.Event(payload);
      const invocationFn = payload._fromSend ? "send" : "emit";
      delete msg._fromSend;
      delete msg.contextUser;
      processContext.user = new cds.User.Privileged({
        id: userId,
        authInfo: await common.getTokenInfo(processContext.tenant),
      });
      processContext._eventQueue = { processor: this, key, queueEntries, payload };
      const result = await cds.unboxed(service).tx(processContext)[invocationFn](msg);
      return this.#determineResultStatus(result, queueEntries);
    } catch (err) {
      this.logger.error("error processing outboxed service call", err, {
        serviceName: this.eventSubType,
      });
      return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Error]);
    }
  }

  #determineResultStatus(result, queueEntries) {
    const validStatusValues = Object.values(EventProcessingStatus);
    const validStatus = validStatusValues.includes(result);
    if (validStatus) {
      return queueEntries.map((queueEntry) => [queueEntry.ID, validStatus]);
    }

    if (!Array.isArray(result)) {
      return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
    }

    const valid = !result.some((entry) => {
      const [, status] = entry;
      return !validStatusValues.includes(status);
    });

    if (valid) {
      return result;
    } else {
      return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
    }
  }
}

module.exports = EventQueueGenericOutboxHandler;
