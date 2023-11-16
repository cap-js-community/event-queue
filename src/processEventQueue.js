"use strict";

const pathLib = require("path");

const cds = require("@sap/cds");

const config = require("./config");
const { TransactionMode } = require("./constants");
const { limiter } = require("./shared/common");

const { executeInNewTransaction, TriggerRollback } = require("./shared/cdsHelper");

const COMPONENT_NAME = "eventQueue/processEventQueue";
const MAX_EXECUTION_TIME = 5 * 60 * 1000;

const processEventQueue = async (context, eventType, eventSubType, startTime = new Date()) => {
  let iterationCounter = 0;
  let shouldContinue = true;
  let baseInstance;
  try {
    let eventTypeInstance;
    const eventConfig = config.getEventConfig(eventType, eventSubType);
    const [err, EventTypeClass] = resilientRequire(eventConfig?.impl);
    if (!eventConfig || err || !(typeof EventTypeClass.constructor === "function")) {
      cds.log(COMPONENT_NAME).error("No Implementation found in the provided configuration file.", {
        eventType,
        eventSubType,
      });
      return;
    }
    baseInstance = new EventTypeClass(context, eventType, eventSubType, eventConfig);
    const continueProcessing = await baseInstance.handleDistributedLock();
    if (!continueProcessing) {
      return;
    }
    if (baseInstance.isPeriodicEvent) {
      return await processPeriodicEvent(baseInstance);
    }
    eventConfig.startTime = startTime;
    while (shouldContinue) {
      iterationCounter++;
      await executeInNewTransaction(context, `eventQueue-pre-processing-${eventType}##${eventSubType}`, async (tx) => {
        eventTypeInstance = new EventTypeClass(tx.context, eventType, eventSubType, eventConfig);
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
        throw new TriggerRollback();
      });
      await eventTypeInstance.handleExceededEvents();
      if (!eventTypeInstance) {
        return;
      }
      eventTypeInstance.endPerformanceTracerPreprocessing();
      if (Object.keys(eventTypeInstance.queueEntriesWithPayloadMap).length) {
        await executeInNewTransaction(context, `eventQueue-processing-${eventType}##${eventSubType}`, async (tx) => {
          eventTypeInstance.processEventContext = tx.context;
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
            throw new TriggerRollback();
          }
        });
      }
      await executeInNewTransaction(context, `eventQueue-persistStatus-${eventType}##${eventSubType}`, async (tx) => {
        await eventTypeInstance.persistEventStatus(tx);
      });
      shouldContinue = reevaluateShouldContinue(eventTypeInstance, iterationCounter, startTime);
      if (!shouldContinue) {
        await executeInNewTransaction(
          context,
          `eventQueue-deleteFinishedEvents-${eventType}##${eventSubType}`,
          async (tx) => {
            await eventTypeInstance.deleteFinishedEvents(tx);
          }
        );
      }
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
  if (new Date(startTime.getTime() + MAX_EXECUTION_TIME) > new Date()) {
    return true;
  }
  eventTypeInstance.logTimeExceeded(iterationCounter);
  return false;
};

// TODO: don't forget to release lock
const processPeriodicEvent = async (eventTypeInstance) => {
  let queueEntry;
  let processNext = true;

  try {
    while (processNext) {
      await executeInNewTransaction(
        eventTypeInstance.context,
        `eventQueue-periodic-scheduleNext-${eventTypeInstance.eventType}##${eventTypeInstance.eventSubType}`,
        async (tx) => {
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
        }
      );

      if (!queueEntry) {
        return;
      }

      await executeInNewTransaction(
        eventTypeInstance.context,
        `eventQueue-periodic-process-${eventTypeInstance.eventType}##${eventTypeInstance.eventSubType}`,
        async (tx) => {
          eventTypeInstance.processEventContext = tx.context;
          eventTypeInstance.setTxForEventProcessing(queueEntry.ID, cds.tx(tx.context));
          try {
            await eventTypeInstance.processPeriodicEvent(tx.context, queueEntry.ID, queueEntry);
          } catch (err) {
            eventTypeInstance.handleErrorDuringPeriodicEventProcessing(err, queueEntry);
            throw new TriggerRollback();
          }
          if (
            eventTypeInstance.transactionMode !== TransactionMode.alwaysCommit ||
            eventTypeInstance.shouldRollbackTransaction(queueEntry.ID)
          ) {
            throw new TriggerRollback();
          }
        }
      );

      await executeInNewTransaction(
        eventTypeInstance.context,
        `eventQueue-periodic-setStatus-${eventTypeInstance.eventType}##${eventTypeInstance.eventSubType}`,
        async (tx) => {
          eventTypeInstance.processEventContext = tx.context;
          await eventTypeInstance.setPeriodicEventStatus(queueEntry.ID);
        }
      );
    }
  } catch (err) {
    cds.log(COMPONENT_NAME).error("Processing periodic events failed with unexpected error.", err, {
      eventType: eventTypeInstance?.eventType,
      eventSubType: eventTypeInstance?.eventSubType,
    });
  } finally {
    await eventTypeInstance?.handleReleaseLock();
  }
};

const processEventMap = async (eventTypeInstance) => {
  eventTypeInstance.startPerformanceTracerEvents();
  await eventTypeInstance.beforeProcessingEvents();
  if (eventTypeInstance.commitOnEventLevel) {
    eventTypeInstance.txUsageAllowed = false;
  }
  await limiter(
    eventTypeInstance.parallelEventProcessing,
    Object.entries(eventTypeInstance.eventProcessingMap),
    async ([key, { queueEntries, payload }]) => {
      if (eventTypeInstance.commitOnEventLevel) {
        let statusMap;
        await executeInNewTransaction(
          eventTypeInstance.baseContext,
          `eventQueue-processEvent-${eventTypeInstance.eventType}##${eventTypeInstance.eventSubType}`,
          async (tx) => {
            statusMap = await _processEvent(eventTypeInstance, tx.context, key, queueEntries, payload);
            if (
              eventTypeInstance.statusMapContainsError(statusMap) ||
              eventTypeInstance.shouldRollbackTransaction(key)
            ) {
              throw new TriggerRollback();
            }
          }
        );
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
      } else {
        await _processEvent(eventTypeInstance, eventTypeInstance.context, key, queueEntries, payload);
      }
    }
  ).finally(() => {
    eventTypeInstance.clearEventProcessingContext();
    if (eventTypeInstance.commitOnEventLevel) {
      eventTypeInstance.txUsageAllowed = true;
    }
  });
  eventTypeInstance.endPerformanceTracerEvents();
};

const _processEvent = async (eventTypeInstance, processContext, key, queueEntries, payload) => {
  try {
    eventTypeInstance.logStartMessage(queueEntries);
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

const resilientRequire = (path) => {
  try {
    const module = require(pathLib.join(process.cwd(), path));
    return [null, module];
  } catch (err) {
    return [err, null];
  }
};

module.exports = {
  processEventQueue,
};
