"use strict";

const cds = require("@sap/cds");

const EventQueueBaseClass = require("../EventQueueProcessorBase");
const { EventProcessingStatus } = require("../constants");
const common = require("../shared/common");
const config = require("../config");

const COMPONENT_NAME = "/eventQueue/outbox/generic";

const EVENT_QUEUE_ACTIONS = {
  EXCEEDED: "eventQueueRetriesExceeded",
  CLUSTER: "eventQueueCluster",
  CHECK_AND_ADJUST: "eventQueueCheckAndAdjustPayload",
};

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
          const reg = new cds.Request({
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
          const clusterResult = await this.__srvUnboxed.tx(this.context).send(reg);
          if (this.#validateCluster(clusterResult)) {
            Object.assign(clusterMap, clusterResult);
          } else {
            this.logger.error(
              "cluster result of handler is not valid. Check the documentation for the expected structure. Continuing without clustering!",
              {
                handler: reg.event,
                clusterResult: JSON.stringify(clusterResult),
              }
            );
            return super.clusterQueueEntries(queueEntriesWithPayloadMap);
          }
        }
      }
    }

    for (const actionName in specificClusterEvents) {
      const reg = new cds.Request({
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
      const clusterResult = await this.__srvUnboxed.tx(this.context).send(reg);
      if (this.#validateCluster(clusterResult)) {
        Object.assign(clusterMap, clusterResult);
      } else {
        this.logger.error(
          "cluster result of handler is not valid. Check the documentation for the expected structure. Continuing without clustering!",
          {
            handler: reg.event,
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
          throw new Error("hmm??");
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
    const handlerName = this.#checkHandlerExists(EVENT_QUEUE_ACTIONS.CHECK_AND_ADJUST, event);
    if (!handlerName) {
      return payload;
    }

    const { reg, userId } = this.#buildDispatchData(this.context, payload, {
      queueEntries: [queueEntry],
    });
    reg.event = handlerName;
    await this.#setContextUser(this.context, userId, reg);
    const data = await this.__srvUnboxed.tx(this.context).send(reg);
    if (data) {
      payload.data = data;
      return payload;
    } else {
      return null;
    }
  }

  async hookForExceededEvents(exceededEvent) {
    const { event } = exceededEvent.payload;
    const handlerName = this.#checkHandlerExists(EVENT_QUEUE_ACTIONS.EXCEEDED, event);
    if (!handlerName) {
      return await super.hookForExceededEvents(exceededEvent);
    }

    const { reg, userId } = this.#buildDispatchData(this.context, exceededEvent.payload, {
      queueEntries: [exceededEvent],
    });
    await this.#setContextUser(this.context, userId, reg);
    reg.event = handlerName;
    await this.__srvUnboxed.tx(this.context).send(reg);
  }

  // NOTE: Currently not exposed to CAP service; we wait for a valid use case
  async beforeProcessingEvents() {
    return await super.beforeProcessingEvents();
  }

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
    const reg = new cds.Event({ event: action, eventQueue: { processor: this, key, queueEntries: [queueEntry] } });
    await this.#setContextUser(processContext, config.userId, reg);
    await this.__srvUnboxed.tx(processContext).emit(reg);
  }

  #buildDispatchData(context, payload, { key, queueEntries } = {}) {
    const { useEventQueueUser } = this.eventConfig;
    const userId = useEventQueueUser ? config.userId : payload.contextUser;
    const reg = payload._fromSend ? new cds.Request(payload) : new cds.Event(payload);
    const invocationFn = payload._fromSend ? "send" : "emit";
    delete reg._fromSend;
    delete reg.contextUser;
    reg.eventQueue = { processor: this, key, queueEntries, payload };
    return { reg, userId, invocationFn };
  }

  async #setContextUser(context, userId, reg) {
    const authInfo = await common.getAuthContext(context.tenant);
    context.user = new cds.User.Privileged({
      id: userId,
      authInfo,
      tokenInfo: authInfo?.token,
    });
    if (reg) {
      reg.user = context.user;
    }
  }

  async processEvent(processContext, key, queueEntries, payload) {
    try {
      const { userId, invocationFn, reg } = this.#buildDispatchData(processContext, payload, { key, queueEntries });
      await this.#setContextUser(processContext, userId, reg);
      const result = await this.__srvUnboxed.tx(processContext)[invocationFn](reg);
      return this.#determineResultStatus(result, queueEntries);
    } catch (err) {
      this.logger.error("error processing outboxed service call", err, {
        serviceName: this.eventSubType,
      });
      return queueEntries.map((queueEntry) => [
        queueEntry.ID,
        {
          status: EventProcessingStatus.Error,
          error: err,
        },
      ]);
    }
  }

  #determineResultStatus(result, queueEntries) {
    const validStatusValues = Object.values(EventProcessingStatus);
    const validStatus = validStatusValues.includes(result);
    if (validStatus) {
      return queueEntries.map((queueEntry) => [queueEntry.ID, result]);
    }

    if (result instanceof Object && !Array.isArray(result)) {
      return queueEntries.map((queueEntry) => [queueEntry.ID, result]);
    }

    if (!Array.isArray(result)) {
      return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
    }

    const [firstEntry] = result;
    if (Array.isArray(firstEntry)) {
      const [, innerResult] = firstEntry;
      if (innerResult instanceof Object) {
        return result;
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
      return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
    }
  }
}

module.exports = EventQueueGenericOutboxHandler;
