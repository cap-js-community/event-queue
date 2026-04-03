"use strict";

const cds = require("@sap/cds");

const EventQueueBaseClass = require("../EventQueueProcessorBase");
const { EventProcessingStatus } = require("../constants");
const common = require("../shared/common");
const config = require("../config");
const EventQueueError = require("../EventQueueError");

const COMPONENT_NAME = "/eventQueue/outbox/generic";

const EVENT_QUEUE_ACTIONS = {
  EXCEEDED: "eventQueueRetriesExceeded",
  CLUSTER: "eventQueueCluster",
  CHECK_AND_ADJUST: "eventQueueCheckAndAdjustPayload",
  SAGA_SUCCESS: "#succeeded",
  SAGA_FAILED: "#failed",
  SAGA_DONE: "#done",
};

const PROPAGATE_EVENT_QUEUE_ENTRIES = [
  "ID",
  "lastAttempTimestamp",
  "payload",
  "referenceEntity",
  "referenceEntityKey",
  "status",
];

class EventQueueGenericOutboxHandler extends EventQueueBaseClass {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
    this.logger = cds.log(`${COMPONENT_NAME}/${eventSubType}`);
  }

  async getQueueEntriesAndSetToInProgress() {
    const { srvName } = config.normalizeSubType(this.eventType, this.eventSubType);
    this.__srv = await cds.connect.to(srvName);
    this.__srvUnboxed = cds.unqueued(this.__srv);
    const { handlers, clusterRelevant, specificClusterRelevant } = this.__srvUnboxed.handlers.on.reduce(
      (result, handler) => {
        if (handler.on.startsWith(EVENT_QUEUE_ACTIONS.CLUSTER)) {
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
    return await super.getQueueEntriesAndSetToInProgress();
  }

  async clusterQueueEntries(queueEntriesWithPayloadMap) {
    if (!this.__genericClusterRelevantAndAvailable && !this.__specificClusterRelevantAndAvailable) {
      return super.clusterQueueEntries(queueEntriesWithPayloadMap);
    }
    const { genericClusterEvents, specificClusterEvents } = this.#clusterByAction(queueEntriesWithPayloadMap);

    const clusterMap = {};
    if (Object.keys(genericClusterEvents).length) {
      if (!this.__genericClusterRelevantAndAvailable) {
        for (const actionName in genericClusterEvents) {
          await super.clusterQueueEntries(genericClusterEvents[actionName]);
        }
      } else {
        for (const actionName in genericClusterEvents) {
          const req = new cds.Request({
            event: EVENT_QUEUE_ACTIONS.CLUSTER,
            user: this.context.user,
            eventQueue: {
              processor: this,
              clusterByPayloadProperty: (propertyName, cb) =>
                this.#clusterByPayloadProperty(actionName, genericClusterEvents[actionName], propertyName, cb),
              clusterByEventProperty: (propertyName, cb) =>
                this.#clusterByEventProperty(actionName, genericClusterEvents[actionName], propertyName, cb),
              clusterByDataProperty: (propertyName, cb) =>
                this.#clusterByDataProperty(actionName, genericClusterEvents[actionName], propertyName, cb),
            },
          });
          const clusterResult = await this.__srvUnboxed.tx(this.context).send(req);
          if (this.#validateCluster(clusterResult)) {
            Object.assign(clusterMap, clusterResult);
          } else {
            this.logger.error(
              "cluster result of handler is not valid. Check the documentation for the expected structure. Continuing without clustering!",
              {
                handler: req.event,
                clusterResult: JSON.stringify(clusterResult),
              }
            );
            return super.clusterQueueEntries(queueEntriesWithPayloadMap);
          }
        }
      }
    }

    for (const actionName in specificClusterEvents) {
      const req = new cds.Request({
        event: `${EVENT_QUEUE_ACTIONS.CLUSTER}.${actionName}`,
        user: this.context.user,
        eventQueue: {
          processor: this,
          clusterByPayloadProperty: (propertyName, cb) =>
            this.#clusterByPayloadProperty(actionName, specificClusterEvents[actionName], propertyName, cb),
          clusterByEventProperty: (propertyName, cb) =>
            this.#clusterByEventProperty(actionName, specificClusterEvents[actionName], propertyName, cb),
          clusterByDataProperty: (propertyName, cb) =>
            this.#clusterByDataProperty(actionName, specificClusterEvents[actionName], propertyName, cb),
        },
      });
      const clusterResult = await this.__srvUnboxed.tx(this.context).send(req);
      if (this.#validateCluster(clusterResult)) {
        Object.assign(clusterMap, clusterResult);
      } else {
        this.logger.error(
          "cluster result of handler is not valid. Check the documentation for the expected structure. Continuing without clustering!",
          {
            handler: req.event,
            clusterResult: JSON.stringify(clusterResult),
          }
        );
        return super.clusterQueueEntries(queueEntriesWithPayloadMap);
      }
    }
    this.#addToProcessingMap(clusterMap);
  }

  #validateCluster(obj) {
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      return false;
    }

    for (const key of Object.keys(obj)) {
      const clusterEntry = obj[key];
      if (typeof clusterEntry !== "object" || clusterEntry === null || Array.isArray(obj)) {
        return false;
      }

      if (!Array.isArray(clusterEntry.queueEntries)) {
        return false;
      }

      if (
        typeof clusterEntry.payload !== "object" ||
        clusterEntry.payload === null ||
        Array.isArray(clusterEntry.payload)
      ) {
        return false;
      }
    }

    return true;
  }

  clusterBase(queueEntriesWithPayloadMap, propertyName, refCb, cb) {
    const clusters = Object.entries(queueEntriesWithPayloadMap).reduce((result, [, { queueEntry, payload }]) => {
      const ref = refCb(result, payload, queueEntry);
      ref.queueEntries.push(queueEntry);
      return result;
    }, {});

    if (cb) {
      for (const clustersKey in clusters) {
        const clusterData = clusters[clustersKey];
        const clusterResult = cb(
          clustersKey.split("##").pop(),
          clusterData.queueEntries.map((entry) => entry.payload.data)
        );
        if (!clusterResult) {
          throw EventQueueError.invalidClusterHandlerResult(clustersKey, propertyName);
        }
        clusterData.payload.data = clusterResult;
      }
    }
    return clusters;
  }

  #resolveRefBase(result, propertyName, actionName, payload, startRef) {
    const parts = propertyName.split(".");
    const data = JSON.parse(JSON.stringify(payload.data));
    let ref = startRef;
    for (const part of parts) {
      ref = ref[part];
    }
    const key = [actionName, ref].join("##");
    result[key] ??= {
      queueEntries: [],
      payload: { ...payload, data },
    };
    return result[key];
  }

  #clusterByPayloadProperty(actionName, queueEntriesWithPayloadMap, propertyName, cb) {
    return this.clusterBase(
      queueEntriesWithPayloadMap,
      propertyName,
      (result, payload) => this.#resolveRefBase(result, propertyName, actionName, payload, payload),
      cb
    );
  }

  #clusterByEventProperty(actionName, queueEntriesWithPayloadMap, propertyName, cb) {
    return this.clusterBase(
      queueEntriesWithPayloadMap,
      propertyName,
      (result, payload, queueEntry) => this.#resolveRefBase(result, propertyName, actionName, payload, queueEntry),
      cb
    );
  }

  #clusterByDataProperty(actionName, queueEntriesWithPayloadMap, propertyName, cb) {
    return this.clusterBase(
      queueEntriesWithPayloadMap,
      propertyName,
      (result, payload) => this.#resolveRefBase(result, propertyName, actionName, payload, payload.data),
      cb
    );
  }

  #clusterByAction(queueEntriesWithPayloadMap) {
    return Object.entries(queueEntriesWithPayloadMap).reduce(
      (result, [eventId, clusterData]) => {
        const hasSpecificClusterHandler = this.#hasEventSpecificClusterHandler(clusterData.queueEntry);
        if (hasSpecificClusterHandler && this.__specificClusterRelevantAndAvailable) {
          result.specificClusterEvents[clusterData.payload.event] ??= {};
          result.specificClusterEvents[clusterData.payload.event][eventId] = clusterData;
        } else {
          result.genericClusterEvents[clusterData.payload.event] ??= {};
          result.genericClusterEvents[clusterData.payload.event][eventId] = clusterData;
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
    return !!this.__onHandlers[[EVENT_QUEUE_ACTIONS.CLUSTER, queueEntry.payload.event].join(".")];
  }

  async checkEventAndGeneratePayload(queueEntry) {
    const payload = await super.checkEventAndGeneratePayload(queueEntry);
    const { event } = payload;
    const handlerName = this.#checkHandlerExists({ eventQueueFn: EVENT_QUEUE_ACTIONS.CHECK_AND_ADJUST, event });
    if (!handlerName) {
      return payload;
    }

    const { req, userId } = this.#buildDispatchData(payload, {
      queueEntries: [queueEntry],
    });
    req.event = handlerName;
    await this.#setContextUser(this.context, userId, req);
    const data = await this.__srvUnboxed.tx(this.context).send(req);
    if (data) {
      payload.data = data;
      return payload;
    } else {
      return null;
    }
  }

  async hookForExceededEvents(exceededEvent) {
    const { event } = exceededEvent.payload;
    const handlerName = this.#checkHandlerExists({ eventQueueFn: EVENT_QUEUE_ACTIONS.EXCEEDED, event });
    if (!handlerName) {
      return await super.hookForExceededEvents(exceededEvent);
    }

    const { req, userId } = this.#buildDispatchData(exceededEvent.payload, {
      queueEntries: [exceededEvent],
    });
    await this.#setContextUser(this.context, userId, req);
    req.event = handlerName;
    await this.__srvUnboxed.tx(this.context).send(req);
  }

  // NOTE: Currently not exposed to CAP service; we wait for a valid use case
  async beforeProcessingEvents() {
    return await super.beforeProcessingEvents();
  }

  #checkHandlerExists({ eventQueueFn, event, saga } = {}) {
    if (eventQueueFn) {
      const specificHandler = this.__onHandlers[[eventQueueFn, event].join(".")];
      if (specificHandler) {
        return specificHandler;
      }

      const genericHandler = this.__onHandlers[eventQueueFn];
      return genericHandler ?? null;
    }

    if (event.endsWith(EVENT_QUEUE_ACTIONS.SAGA_SUCCESS) || event.endsWith(EVENT_QUEUE_ACTIONS.SAGA_DONE)) {
      [event] = event.split("/");
    }

    const specificHandler = this.__onHandlers[[event, saga].join("/")];
    if (specificHandler) {
      return specificHandler;
    }

    return this.__onHandlers[saga];
  }

  async processPeriodicEvent(processContext, key, queueEntry) {
    const { actionName } = config.normalizeSubType(this.eventType, this.eventSubType);
    const req = new cds.Event({ event: actionName, eventQueue: { processor: this, key, queueEntries: [queueEntry] } });
    await this.#setContextUser(processContext, config.userId, req);
    await this.__srvUnboxed.tx(processContext).emit(req);
  }

  #buildDispatchData(payload, { key, queueEntries } = {}) {
    const { useEventQueueUser } = this.eventConfig;
    const userId = useEventQueueUser ? config.userId : payload.contextUser;
    let triggerEvent;

    if (payload.data?.triggerEvent) {
      try {
        triggerEvent = JSON.parse(payload.data.triggerEvent);
      } catch (err) {
        this.logger.error("[saga] error parsing triggering event data", err);
      } finally {
        delete payload.data.triggerEvent;
      }
    }

    const req = payload._fromSend ? new cds.Request(payload) : new cds.Event(payload);
    const invocationFn = payload._fromSend ? "send" : "emit";
    delete req._fromSend;
    delete req.contextUser;
    req.eventQueue = { processor: this, key, queueEntries, payload, triggerEvent };

    if (this.eventConfig.propagateContextProperties?.length && this.transactionMode === "isolated" && cds.context) {
      for (const prop of this.eventConfig.propagateContextProperties) {
        req[prop] && (cds.context[prop] = req[prop]);
      }
    }

    return { req, userId, invocationFn };
  }

  async #setContextUser(context, userId, req) {
    const authInfo = await common.getAuthContext(context.tenant);
    context.user = new cds.User.Privileged({
      id: userId,
      authInfo,
      tokenInfo: authInfo?.token,
    });
    if (req) {
      req.user = context.user;
    }
  }

  async processEvent(processContext, key, queueEntries, payload) {
    let statusTuple, result;
    const { userId, invocationFn, req } = this.#buildDispatchData(payload, { key, queueEntries });
    try {
      await this.#setContextUser(processContext, userId, req);
      result = await this.__srvUnboxed.tx(processContext)[invocationFn](req);
      statusTuple = this.#determineResultStatus(result, queueEntries);
    } catch (err) {
      this.logger.error("error processing outboxed service call", err, {
        serviceName: this.eventSubType,
      });
      statusTuple = queueEntries.map((queueEntry) => [
        queueEntry.ID,
        {
          status: EventProcessingStatus.Error,
          error: err,
        },
      ]);
    }

    await this.#publishFollowupEvents(processContext, req, statusTuple, result);
    return statusTuple;
  }

  async #publishFollowupEvents(processContext, req, statusTuple, triggerEventResult) {
    const succeeded = this.#checkHandlerExists({ event: req.event, saga: EVENT_QUEUE_ACTIONS.SAGA_SUCCESS });
    const failed = this.#checkHandlerExists({ event: req.event, saga: EVENT_QUEUE_ACTIONS.SAGA_FAILED });
    const done = this.#checkHandlerExists({ event: req.event, saga: EVENT_QUEUE_ACTIONS.SAGA_DONE });

    if (!succeeded && !failed && !done) {
      return;
    }

    if (req.event.endsWith(EVENT_QUEUE_ACTIONS.SAGA_FAILED) || req.event.endsWith(EVENT_QUEUE_ACTIONS.SAGA_DONE)) {
      return;
    }

    // NOTE: required for #failed because tx is rolledback and new events would not be commmited!
    const tx = cds.tx(processContext);
    const nextEvents = tx._eventQueue?.events;

    if (nextEvents?.length) {
      tx._eventQueue.events = [];
    }

    const queued = cds.queued(this.__srv);
    for (const [, result] of statusTuple) {
      const data = result.nextData ?? req.data;
      if (
        succeeded &&
        result.status === EventProcessingStatus.Done &&
        !req.event.endsWith(EVENT_QUEUE_ACTIONS.SAGA_SUCCESS)
      ) {
        if (statusTuple.length === 1 && req.eventQueue.queueEntries.length === 1) {
          const triggerEventPropagate = { triggerEventResult };
          const [triggerEvent] = req.eventQueue.queueEntries;
          for (const propertyName of PROPAGATE_EVENT_QUEUE_ENTRIES) {
            triggerEventPropagate[propertyName] = triggerEvent[propertyName];
          }
          data.triggerEvent = JSON.stringify(triggerEventPropagate);
        }

        await queued.tx(processContext).send(succeeded, data);
      }

      if (failed && result.status === EventProcessingStatus.Error) {
        result.error && (data.error = this._error2String(result.error));
        if (statusTuple.length === 1 && req.eventQueue.queueEntries.length === 1) {
          const triggerEventPropagate = { triggerEventResult };
          const [triggerEvent] = req.eventQueue.queueEntries;
          for (const propertyName of PROPAGATE_EVENT_QUEUE_ENTRIES) {
            triggerEventPropagate[propertyName] = triggerEvent[propertyName];
          }
          data.triggerEvent = JSON.stringify(triggerEventPropagate);
        }
        await queued.tx(processContext).send(failed, data);
      }

      if (done && !req.event.endsWith(EVENT_QUEUE_ACTIONS.SAGA_SUCCESS)) {
        if (statusTuple.length === 1 && req.eventQueue.queueEntries.length === 1) {
          const triggerEventPropagate = { triggerEventResult };
          const [triggerEvent] = req.eventQueue.queueEntries;
          for (const propertyName of PROPAGATE_EVENT_QUEUE_ENTRIES) {
            triggerEventPropagate[propertyName] = triggerEvent[propertyName];
          }
          data.triggerEvent = JSON.stringify(triggerEventPropagate);
        }
        await queued.tx(processContext).send(done, data);
      }

      delete result.nextData;
    }

    if (config.insertEventsBeforeCommit) {
      this.nextSagaEvents = tx._eventQueue?.events;
    } else {
      const hasError = statusTuple.some(([, result]) => result.status === EventProcessingStatus.Error);
      this.nextSagaEvents = tx._eventQueue?.events.filter((event) => {
        const eventName = JSON.parse(event.payload).event;
        return eventName === failed || (hasError && eventName === done);
      });
    }

    if (tx._eventQueue) {
      tx._eventQueue.events = nextEvents ?? [];
    }
  }

  #determineResultStatus(result, queueEntries) {
    const validStatusValues = Object.values(EventProcessingStatus);
    const validStatus = validStatusValues.includes(result);
    if (validStatus) {
      return queueEntries.map((queueEntry) => [queueEntry.ID, { status: result }]);
    }

    if (result instanceof Object && !Array.isArray(result)) {
      const allAllowed = !Object.keys(result).some((name) => !this.allowedFieldsEventHandler.includes(name));
      return queueEntries.map((queueEntry) => [
        queueEntry.ID,
        allAllowed ? result : { status: EventProcessingStatus.Done },
      ]);
    }

    if (!Array.isArray(result)) {
      return queueEntries.map((queueEntry) => [queueEntry.ID, { status: EventProcessingStatus.Done }]);
    }

    const [firstEntry] = result;
    if (Array.isArray(firstEntry)) {
      const [, innerResult] = firstEntry;
      if (innerResult instanceof Object) {
        const allAllowed = !Object.keys(innerResult).some((name) => !this.allowedFieldsEventHandler.includes(name));
        if (allAllowed) {
          return result;
        }
        return queueEntries.map((queueEntry) => [queueEntry.ID, { status: EventProcessingStatus.Done }]);
      } else {
        return result.map(([id, status]) => {
          return [id, { status }];
        });
      }
    } else if (firstEntry instanceof Object) {
      return result.reduce((result, entry) => {
        let { ID } = entry;

        if (!ID) {
          if (queueEntries.length > 1) {
            throw new Error(
              "The CAP handler return value does not match the event-queue specification. Please check the documentation"
            );
          } else {
            ID = queueEntries[0].ID;
          }
        }

        delete entry.ID;
        const allAllowed = !Object.keys(entry).some((name) => !this.allowedFieldsEventHandler.includes(name));

        if (!allAllowed) {
          result.push([ID, { status: EventProcessingStatus.Done }]);
        }

        if (!("status" in entry)) {
          entry.status = EventProcessingStatus.Done;
        }

        result.push([ID, entry]);
        return result;
      }, []);
    }

    const valid = !result.some((entry) => {
      const [, status] = entry;
      return !validStatusValues.includes(status);
    });

    if (valid) {
      return result;
    } else {
      return queueEntries.map((queueEntry) => [queueEntry.ID, { status: EventProcessingStatus.Done }]);
    }
  }
}

module.exports = EventQueueGenericOutboxHandler;
