"use strict";

const pathLib = require("path");

const cds = require("@sap/cds");

const config = require("./config");
const { TransactionMode, EventProcessingStatus } = require("./constants");
const { limiter } = require("./shared/common");

const { executeInNewTransaction } = require("./shared/cdsHelper");
const trace = require("./shared/openTelemetry");

const COMPONENT_NAME = "/eventQueue/processEventQueue";

const processEventQueue = async (context, eventType, eventSubType, startTime = new Date()) => {
  let iterationCounter = 0;
  let shouldContinue = true;
  let baseInstance;
  try {
    let eventTypeInstance;
    const eventConfig = config.getEventConfig(eventType, eventSubType);
    const [err, EventTypeClass] = resilientRequire(eventConfig);
    if (!eventConfig || err || !(typeof EventTypeClass.constructor === "function")) {
      cds.log(COMPONENT_NAME).error("No Implementation found in the provided configuration file.", {
        eventType,
        eventSubType,
      });
      return;
    }
    baseInstance = new EventTypeClass(context, eventType, eventSubType, eventConfig);
    if (await _checkEventIsBlocked(baseInstance)) {
      return;
    }

    const continueProcessing = await baseInstance.acquireDistributedLock();
    if (!continueProcessing) {
      return;
    }
    if (baseInstance.isPeriodicEvent) {
      return await processPeriodicEvent(context, baseInstance);
    }
    eventConfig.startTime = startTime;
    while (shouldContinue) {
      iterationCounter++;
      await executeInNewTransaction(context, `eventQueue-pre-processing-${eventType}##${eventSubType}`, async (tx) => {
        eventTypeInstance = new EventTypeClass(tx.context, eventType, eventSubType, eventConfig);
        await trace(eventTypeInstance.context, "preparation", async () => {
          const queueEntries = await eventTypeInstance.getQueueEntriesAndSetToInProgress();
          eventTypeInstance.startPerformanceTracerPreprocessing();
          for (const queueEntry of queueEntries) {
            try {
              eventTypeInstance.modifyQueueEntry(queueEntry);
              const payload = await eventTypeInstance.checkEventAndGeneratePayload(queueEntry);
              if (payload === null) {
                eventTypeInstance.setStatusToDone(queueEntry);
                continue;
              }
              if (payload === undefined) {
                eventTypeInstance.handleInvalidPayloadReturned(queueEntry);
                continue;
              }
              eventTypeInstance.addEventWithPayloadForProcessing(queueEntry, payload);
            } catch (err) {
              eventTypeInstance.handleErrorDuringProcessing(err, queueEntry);
            }
          }
          await tx.rollback();
        });
      });
      await eventTypeInstance.handleExceededEvents();
      if (!eventTypeInstance) {
        return;
      }
      eventTypeInstance.endPerformanceTracerPreprocessing();
      if (Object.keys(eventTypeInstance.queueEntriesWithPayloadMap).length) {
        await executeInNewTransaction(context, `eventQueue-processing-${eventType}##${eventSubType}`, async (tx) => {
          eventTypeInstance.processEventContext = tx.context;
          await trace(eventTypeInstance.context, "process-events", async () => {
            try {
              eventTypeInstance.clusterQueueEntries(eventTypeInstance.queueEntriesWithPayloadMap);
              await processEventMap(eventTypeInstance);
            } catch (err) {
              eventTypeInstance.handleErrorDuringClustering(err);
            }
            if (
              eventTypeInstance.transactionMode !== TransactionMode.alwaysCommit ||
              Object.entries(eventTypeInstance.eventProcessingMap).some(([key]) =>
                eventTypeInstance.shouldRollbackTransaction(key)
              )
            ) {
              await tx.rollback();
            }
          });
        });
      }
      await executeInNewTransaction(context, `eventQueue-persistStatus-${eventType}##${eventSubType}`, async (tx) => {
        await eventTypeInstance.persistEventStatus(tx);
      });
      shouldContinue = reevaluateShouldContinue(eventTypeInstance, iterationCounter, startTime);
    }
  } catch (err) {
    cds.log(COMPONENT_NAME).error("Processing event queue failed with unexpected error.", err, {
      eventType,
      eventSubType,
    });
  } finally {
    await baseInstance?.handleReleaseLock();
  }
};

const reevaluateShouldContinue = (eventTypeInstance, iterationCounter, startTime) => {
  if (!eventTypeInstance.selectNextChunk) {
    return false; // no select next chunk configured for this event
  }
  if (eventTypeInstance.emptyChunkSelected) {
    return false; // the last selected chunk was empty - no more data for processing
  }
  if (new Date(startTime.getTime() + config.runInterval) > new Date()) {
    return true;
  }

  eventTypeInstance.logTimeExceededAndPublishContinue(iterationCounter);
  return false;
};

const processPeriodicEvent = async (context, eventTypeInstance) => {
  try {
    let queueEntry;
    let processNext = true;
    while (processNext) {
      await executeInNewTransaction(
        eventTypeInstance.context,
        `eventQueue-periodic-scheduleNext-${eventTypeInstance.eventType}##${eventTypeInstance.eventSubType}`,
        async (tx) => {
          await trace(eventTypeInstance.context, "periodic-event-preparation", async () => {
            eventTypeInstance.processEventContext = tx.context;
            const queueEntries = await eventTypeInstance.getQueueEntriesAndSetToInProgress();
            if (!queueEntries.length) {
              return;
            }
            if (queueEntries.length > 1) {
              queueEntry = await eventTypeInstance.handleDuplicatedPeriodicEventEntry(queueEntries);
            } else {
              queueEntry = queueEntries[0];
            }
            processNext = await eventTypeInstance.scheduleNextPeriodEvent(queueEntry);
          });
        }
      );

      if (!queueEntry) {
        return;
      }

      let status = EventProcessingStatus.Done;
      await executeInNewTransaction(
        eventTypeInstance.context,
        `eventQueue-periodic-process-${eventTypeInstance.eventType}##${eventTypeInstance.eventSubType}`,
        async (tx) => {
          await trace(eventTypeInstance.context, "process-periodic-event", async () => {
            eventTypeInstance.processEventContext = tx.context;
            eventTypeInstance.setTxForEventProcessing(queueEntry.ID, cds.tx(tx.context));
            try {
              eventTypeInstance.startPerformanceTracerPeriodicEvents();
              await eventTypeInstance.processPeriodicEvent(tx.context, queueEntry.ID, queueEntry);
            } catch (err) {
              status = EventProcessingStatus.Error;
              eventTypeInstance.handleErrorDuringPeriodicEventProcessing(err, queueEntry);
              await tx.rollback();
              return;
            } finally {
              eventTypeInstance.endPerformanceTracerPeriodicEvents();
            }
            if (
              eventTypeInstance.transactionMode === TransactionMode.alwaysRollback ||
              eventTypeInstance.shouldRollbackTransaction(queueEntry.ID)
            ) {
              await tx.rollback();
            }
          });
        }
      );

      await executeInNewTransaction(
        eventTypeInstance.context,
        `eventQueue-periodic-setStatus-${eventTypeInstance.eventType}##${eventTypeInstance.eventSubType}`,
        async (tx) => {
          await trace(eventTypeInstance.context, "periodic-event-set-status", async () => {
            eventTypeInstance.processEventContext = tx.context;
            await eventTypeInstance.setPeriodicEventStatus(queueEntry.ID, status);
          });
        }
      );
    }
  } catch (err) {
    cds.log(COMPONENT_NAME).error("Processing periodic events failed with unexpected error.", err, {
      eventType: eventTypeInstance?.eventType,
      eventSubType: eventTypeInstance?.eventSubType,
    });
  }
};

const processEventMap = async (instance) => {
  instance.startPerformanceTracerEvents();
  await instance.beforeProcessingEvents();
  instance.logStartMessage();
  if (instance.commitOnEventLevel) {
    instance.txUsageAllowed = false;
  }
  await limiter(
    instance.parallelEventProcessing,
    Object.entries(instance.eventProcessingMap),
    async ([key, { queueEntries, payload }]) => {
      if (instance.commitOnEventLevel) {
        let statusMap;
        await executeInNewTransaction(
          instance.baseContext,
          `eventQueue-processEvent-${instance.eventType}##${instance.eventSubType}`,
          async (tx) => {
            statusMap = await _processEvent(instance, tx.context, key, queueEntries, payload);
            const shouldRollback =
              instance.statusMapContainsError(statusMap) || instance.shouldRollbackTransaction(key);
            if (shouldRollback) {
              await tx.rollback();
              await _commitStatusInNewTx(instance, statusMap);
            } else {
              await instance.persistEventStatus(tx, {
                skipChecks: true,
                statusMap,
              });
            }
          }
        );
      } else {
        await _processEvent(instance, instance.context, key, queueEntries, payload);
      }
    }
  )
    .catch((err) => {
      instance.handleErrorTx(err);
    })
    .finally(() => {
      instance.clearEventProcessingContext();
      if (instance.commitOnEventLevel) {
        instance.txUsageAllowed = true;
      }
    });
  instance.endPerformanceTracerEvents();
};

const _commitStatusInNewTx = async (eventTypeInstance, statusMap) =>
  await executeInNewTransaction(
    eventTypeInstance.baseContext,
    `eventQueue-persistStatus-${eventTypeInstance.eventType}##${eventTypeInstance.eventSubType}`,
    async (tx) => {
      eventTypeInstance.processEventContext = tx.context;
      await eventTypeInstance.persistEventStatus(tx, {
        skipChecks: true,
        statusMap,
      });
    }
  );

const _checkEventIsBlocked = async (baseInstance) => {
  const isEventBlockedCb = config.isEventBlockedCb;
  let eventBlocked;
  if (isEventBlockedCb) {
    try {
      eventBlocked = await isEventBlockedCb(
        baseInstance.eventType,
        baseInstance.eventSubType,
        baseInstance.isPeriodicEvent,
        baseInstance.context.tenant
      );
    } catch (err) {
      eventBlocked = true;
      baseInstance.logger.error("skipping run because periodic event blocked check failed!", err, {
        type: baseInstance.eventType,
        subType: baseInstance.eventSubType,
      });
    }
  } else {
    // TODO: we should be able to get rid of baseInstance.isPeriodicEvent with rawEventType
    eventBlocked = config.isEventBlocked(
      baseInstance.eventType,
      baseInstance.eventSubType,
      baseInstance.isPeriodicEvent,
      baseInstance.context.tenant
    );
  }

  if (!eventBlocked) {
    eventBlocked = config.isTenantUnsubscribed(baseInstance.context.tenant);
  }

  if (eventBlocked) {
    baseInstance.logger.info("skipping run because event is blocked by configuration", {
      type: baseInstance.rawEventType,
      subType: baseInstance.eventSubType,
      tenantUnsubscribed: config.isTenantUnsubscribed(baseInstance.context.tenant),
    });
  }

  if (!eventBlocked) {
    eventBlocked = !config.shouldBeProcessedInThisApplication(baseInstance.rawEventType, baseInstance.eventSubType);
  }

  return eventBlocked;
};

const _processEvent = async (eventTypeInstance, processContext, key, queueEntries, payload) => {
  try {
    const eventOutdated = await eventTypeInstance.isOutdatedAndKeepalive(queueEntries);
    if (eventOutdated) {
      return;
    }
    eventTypeInstance.setTxForEventProcessing(key, cds.tx(processContext));
    const statusTuple = await eventTypeInstance.processEvent(processContext, key, queueEntries, payload);
    return eventTypeInstance.setEventStatus(queueEntries, statusTuple);
  } catch (err) {
    return eventTypeInstance.handleErrorDuringProcessing(err, queueEntries);
  }
};

const resilientRequire = (eventConfig) => {
  try {
    const path = eventConfig?.impl;
    const internal = eventConfig?.internalEvent;
    const module = require(pathLib.join(internal ? __dirname : process.cwd(), path));
    return [null, module];
  } catch (err) {
    return [err, null];
  }
};

module.exports = {
  processEventQueue,
};
