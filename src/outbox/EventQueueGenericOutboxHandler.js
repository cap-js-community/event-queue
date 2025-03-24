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

  async getQueueEntriesAndSetToInProgress() {
    const [serviceName] = this.eventSubType.split(".");
    this.__srv = await cds.connect.to(serviceName);
    this.__srvUnboxed = cds.unboxed(this.__srv);
    const { handlers, clusterRelevant, specificClusterRelevant } = this.__srvUnboxed.handlers.on.reduce(
      (result, handler) => {
        if (handler.on.startsWith("clusterQueueEntries")) {
          if (handler.on.split(".").length === 2) {
            result.specificClusterRelevant = true;
          } else {
            result.clusterRelevant = true;
          }
        }

        result.handlers[handler.on] = handler.on;
        return result;
      },
      { handlers: {}, clusterRelevant: false, specificClusterRelevant: false }
    );
    this.__onHandlers = handlers;
    this.__genericClusterHandler = clusterRelevant;
    this.__specificClusterHandler = specificClusterRelevant;
    await this.#setContextUser(this.context, config.userId);
    return super.getQueueEntriesAndSetToInProgress();
  }

  // NOTE: issue here: if events are not sorted before it might not be unique here:
  //       - we have service events
  //       - we have action specific events
  // 1. I need to collect all action names
  // 2. I need to check for which actions a handler exits
  // 3. For actions with specific existing handler --> call specific action
  // 4. For all others call generic handler
  // NOTE: OVERALL idea is that the handler returns the cluster map and MUST not call any baseImpl functions!
  //      --> structure is a map of { key: { queueEntries: [], payload: {} }
  // TODO: document that clusterQueueEntries is now async!!!
  // TODO: validate that return structure is as expected
  async clusterQueueEntries(queueEntriesWithPayloadMap) {
    if (!this.__genericClusterRelevantAndAvailable && !this.__specificClusterRelevantAndAvailable) {
      return super.clusterQueueEntries(queueEntriesWithPayloadMap);
    }
    const { genericClusterEvents, specificClusterEvents } = this.#clusterByAction(queueEntriesWithPayloadMap);
    if (Object.keys(genericClusterEvents).length) {
      if (!this.__genericClusterRelevantAndAvailable) {
        await super.clusterQueueEntries(genericClusterEvents);
      } else {
        const msg = new cds.Request({
          event: "clusterQueueEntries",
          data: { queueEntriesWithPayloadMap: genericClusterEvents },
          eventQueue: {
            processor: this,
            clusterByPayloadProperty: (propertyName) =>
              EventQueueGenericOutboxHandler.clusterByPayloadProperty(genericClusterEvents, propertyName),
            clusterByEventProperty: (propertyName) =>
              EventQueueGenericOutboxHandler.clusterByEventProperty(genericClusterEvents, propertyName),
          },
        });
        const handlerCluster = await this.__srvUnboxed.tx(this.context).send(msg);
        this.#addToProcessingMap(handlerCluster);
      }
    }

    for (const actionName in specificClusterEvents) {
      const msg = new cds.Request({
        event: `clusterQueueEntries.${actionName}`,
        data: { queueEntriesWithPayloadMap: specificClusterEvents[actionName] },
        eventQueue: {
          processor: this,
          clusterByPayloadProperty: (propertyName) =>
            EventQueueGenericOutboxHandler.clusterByPayloadProperty(specificClusterEvents[actionName], propertyName),
          clusterByEventProperty: (propertyName) =>
            EventQueueGenericOutboxHandler.clusterByEventProperty(specificClusterEvents[actionName], propertyName),
        },
      });
      const handlerCluster = await this.__srvUnboxed.tx(this.context).send(msg);
      this.#addToProcessingMap(handlerCluster);
    }
  }

  static clusterByPayloadProperty(queueEntriesWithPayloadMap, propertyName) {
    return Object.entries(queueEntriesWithPayloadMap).reduce((result, [, { queueEntry, payload }]) => {
      result[payload[propertyName]] ??= {
        queueEntries: [],
        payload,
      };
      result[payload[propertyName]].queueEntries.push(queueEntry);
      return result;
    }, {});
  }

  static clusterByEventProperty(queueEntriesWithPayloadMap, propertyName) {
    return Object.entries(queueEntriesWithPayloadMap).reduce((result, [, { queueEntry, payload }]) => {
      result[queueEntry[propertyName]] ??= {
        queueEntries: [],
        payload,
      };
      result[queueEntry[propertyName]].queueEntries.push(queueEntry);
      return result;
    }, {});
  }

  #clusterByAction(queueEntriesWithPayloadMap) {
    return Object.entries(queueEntriesWithPayloadMap).reduce(
      (result, [eventId, clusterData]) => {
        const hasSpecificClusterHandler = this.#hasEventSpecificClusterHandler(clusterData.queueEntry);
        if (hasSpecificClusterHandler && this.__specificClusterRelevantAndAvailable) {
          result.specificClusterEvents[clusterData.payload.event] ??= {};
          result.specificClusterEvents[clusterData.payload.event][eventId] = clusterData;
        } else {
          result.genericClusterEvents[eventId] = clusterData;
        }
        return result;
      },
      { genericClusterEvents: {}, specificClusterEvents: {} }
    );
  }

  #addToProcessingMap(handlerCluster) {
    for (const clusterKey in handlerCluster) {
      const { payload, queueEntries } = handlerCluster[clusterKey];
      for (const queueEntry of queueEntries) {
        this.addEntryToProcessingMap(clusterKey, queueEntry, payload);
      }
    }
  }

  // NOTE: Currently not exposed to CAP service; I don't see any valid use case at this time
  modifyQueueEntry(queueEntry) {
    super.modifyQueueEntry(queueEntry);
    const hasSpecificClusterHandler = this.#hasEventSpecificClusterHandler(queueEntry);
    if (this.__specificClusterHandler && hasSpecificClusterHandler) {
      this.__specificClusterRelevantAndAvailable = true;
    }
    if (this.__genericClusterHandler && !hasSpecificClusterHandler) {
      this.__genericClusterRelevantAndAvailable = true;
    }
  }

  #hasEventSpecificClusterHandler(queueEntry) {
    return !!this.__onHandlers[["clusterQueueEntries", queueEntry.payload.event].join(".")];
  }

  async checkEventAndGeneratePayload(queueEntry) {
    const payload = await super.checkEventAndGeneratePayload(queueEntry);
    const { event } = payload;
    const handlerName = this.#checkHandlerExists("checkEventAndGeneratePayload", event);
    if (!handlerName) {
      return payload;
    }

    const { msg, userId } = this.#buildDispatchData(this.context, payload, {
      queueEntries: [queueEntry],
    });
    msg.event = handlerName;
    await this.#setContextUser(this.context, userId);
    const data = await this.__srvUnboxed.tx(this.context).send(msg);
    if (data) {
      payload.data = data;
      return payload;
    } else {
      return null;
    }
  }

  // simple here as per entry
  async hookForExceededEvents(exceededEvent) {
    return await super.hookForExceededEvents(exceededEvent);
  }

  async beforeProcessingEvents() {
    return await super.beforeProcessingEvents();
  }

  // maybe async getter on req.data // only for periodic events
  // getLastSuccessfulRunTimestamp

  #checkHandlerExists(eventQueueFn, event) {
    const specificHandler = this.__onHandlers[[eventQueueFn, event].join(".")];
    if (specificHandler) {
      return specificHandler;
    }

    const genericHandler = this.__onHandlers[eventQueueFn];
    return genericHandler ?? null;
  }

  async processPeriodicEvent(processContext, key, queueEntry) {
    const [, action] = this.eventSubType.split(".");
    const msg = new cds.Event({ event: action, eventQueue: { processor: this, key, queueEntries: [queueEntry] } });
    await this.#setContextUser(processContext, config.userId);
    await this.__srvUnboxed.tx(processContext).emit(msg);
  }

  #buildDispatchData(context, payload, { key, queueEntries } = {}) {
    // const { payload } = queueEntry;
    const { useEventQueueUser } = this.eventConfig;
    const userId = useEventQueueUser ? config.userId : payload.contextUser;
    const msg = payload._fromSend ? new cds.Request(payload) : new cds.Event(payload);
    const invocationFn = payload._fromSend ? "send" : "emit";
    delete msg._fromSend; // TODO: this changes the source object --> check after multiple invocations
    delete msg.contextUser;
    msg.eventQueue = { processor: this, key, queueEntries, payload };
    return { msg, userId, invocationFn };
  }

  async #setContextUser(context, userId) {
    context.user = new cds.User.Privileged({
      id: userId,
      authInfo: await common.getTokenInfo(this.baseContext.tenant),
    });
  }

  async processEvent(processContext, key, queueEntries, payload) {
    try {
      const { userId, invocationFn, msg } = this.#buildDispatchData(processContext, payload, { key, queueEntries });
      await this.#setContextUser(processContext, userId);
      const result = await this.__srvUnboxed.tx(processContext)[invocationFn](msg);
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
      return queueEntries.map((queueEntry) => [queueEntry.ID, result]);
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
