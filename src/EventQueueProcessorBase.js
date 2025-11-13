"use strict";

const cds = require("@sap/cds");
const { CronExpressionParser } = require("cron-parser");

const { executeInNewTransaction } = require("./shared/cdsHelper");
const { EventProcessingStatus, TransactionMode } = require("./constants");
const distributedLock = require("./shared/distributedLock");
const EventQueueError = require("./EventQueueError");
const { arrayToFlatMap } = require("./shared/common");
const eventScheduler = require("./shared/eventScheduler");
const eventConfig = require("./config");
const PerformanceTracer = require("./shared/PerformanceTracer");
const { trace } = require("./shared/openTelemetry");
const SetIntervalDriftSafe = require("./shared/SetIntervalDriftSafe");

const IMPLEMENT_ERROR_MESSAGE = "needs to be reimplemented";
const COMPONENT_NAME = "/eventQueue/EventQueueProcessorBase";

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_PARALLEL_EVENT_PROCESSING = 1;
const LIMIT_PARALLEL_EVENT_PROCESSING = 10;
const SELECT_LIMIT_EVENTS_PER_TICK = 100;
const TRIES_FOR_EXCEEDED_EVENTS = 3;
const EVENT_START_AFTER_HEADROOM = 3 * 1000;
const SUFFIX_PERIODIC = "_PERIODIC";
const DEFAULT_RETRY_AFTER = 5 * 60 * 1000;

const ALLOWED_FIELDS_FOR_UPDATE = ["status", "startAfter"];

class EventQueueProcessorBase {
  #eventsWithExceededTries = [];
  #exceededTriesExceeded = [];
  #selectedEventMap = {};
  #queueEntriesWithPayloadMap = {};
  #eventType = null;
  #eventSubType = null;
  #config = null;
  #eventSchedulerInstance = null;
  #eventConfig;
  #isPeriodic;
  #lastSuccessfulRunTimestamp;
  #retryFailedAfter;
  #keepAliveRunner;
  #currentKeepAlivePromise = Promise.resolve();
  #etagMap;
  #namespace;

  constructor(context, eventType, eventSubType, config) {
    this.__context = context;
    this.__baseContext = context;
    this.__tx = cds.tx(context);
    this.__baseLogger = cds.log(COMPONENT_NAME);
    this.#namespace = config.namespace;
    this.#eventSchedulerInstance = eventScheduler.getInstance();
    this.#config = eventConfig;
    this.#isPeriodic = this.#config.isPeriodicEvent(eventType, eventSubType, this.#namespace);
    this.__logger = null;
    this.__eventProcessingMap = {};
    this.__statusMap = {};
    this.__commitedStatusMap = {};
    this.__notCommitedStatusMap = {};
    this.__outdatedEventMap = {};
    this.#eventType = eventType;
    this.#eventSubType = eventSubType;
    this.#eventConfig = config ?? {};
    this.__parallelEventProcessing = this.#eventConfig.parallelEventProcessing ?? DEFAULT_PARALLEL_EVENT_PROCESSING;
    if (this.__parallelEventProcessing > LIMIT_PARALLEL_EVENT_PROCESSING) {
      this.__parallelEventProcessing = LIMIT_PARALLEL_EVENT_PROCESSING;
    }
    this.#retryFailedAfter = this.#eventConfig.retryFailedAfter ?? DEFAULT_RETRY_AFTER;
    this.__concurrentEventProcessing = this.#eventConfig.multiInstanceProcessing;
    this.__retryAttempts = this.#isPeriodic ? 1 : this.#eventConfig.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    this.__selectMaxChunkSize = this.#eventConfig.selectMaxChunkSize ?? SELECT_LIMIT_EVENTS_PER_TICK;
    this.__selectNextChunk = !!this.#eventConfig.checkForNextChunk;
    this.__transactionMode = this.#eventConfig.transactionMode ?? TransactionMode.isolated;
    this.__emptyChunkSelected = false;
    this.__lockAcquired = false;
    this.__txUsageAllowed = true;
    this.__txMap = {};
    this.__txRollback = {};
    this.__queueEntries = [];
    this.#keepAliveRunner = new SetIntervalDriftSafe(this.#eventConfig.keepAliveInterval * 1000);
  }

  /**
   * Process one or multiple events depending on the clustering algorithm by default there it's one event
   * @param processContext the context valid for the event processing. This context is associated with a valid transaction
   *                       Access to the context is also possible with this.getContextForEventProcessing(key).
   *                       The associated tx can be accessed with this.getTxForEventProcessing(key).
   * @param {string} key cluster key generated during the clustering step. By default, this is ID of the event queue entry
   * @param {Array<Object>} queueEntries this are the queueEntries which are collected during the clustering step for the given
   *        clustering key
   * @param {Object} payload resulting from the functions checkEventAndGeneratePayload and the clustering function
   * @returns {Promise<Array <Array <String, Number>>>} Must return an array of the length of passed queueEntries
   *          This array needs to be nested based on the following structure: [ ["eventId1", EventProcessingStatus.Done],
   *          ["eventId2", EventProcessingStatus.Error] ]
   */
  // eslint-disable-next-line no-unused-vars
  async processEvent(processContext, key, queueEntries, payload) {
    throw new Error(IMPLEMENT_ERROR_MESSAGE);
  }

  /**
   * Process one periodic event
   * @param processContext the context valid for the event processing. This context is associated with a valid transaction
   *                       Access to the context is also possible with this.getContextForEventProcessing(key).
   *                       The associated tx can be accessed with this.getTxForEventProcessing(key).
   * @param {string} key cluster key generated during the clustering step. By default, this is ID of the event queue entry
   * @param {Object} queueEntry this is the queueEntry which should be processed
   * @returns {Promise<undefined>}
   */
  // eslint-disable-next-line no-unused-vars
  async processPeriodicEvent(processContext, key, queueEntry) {
    throw new Error(IMPLEMENT_ERROR_MESSAGE);
  }

  startPerformanceTracerEvents() {
    this.__performanceLoggerEvents = new PerformanceTracer(this.logger, "Processing events", {
      properties: {
        type: this.eventType,
        subType: this.eventSubType,
      },
    });
  }

  startPerformanceTracerPeriodicEvents() {
    this.__performanceLoggerPeriodicEvents = new PerformanceTracer(this.logger, "Processing periodic event", {
      properties: {
        type: this.eventType,
        subType: this.eventSubType,
      },
    });
  }

  startPerformanceTracerPreprocessing() {
    this.__performanceLoggerPreprocessing = new PerformanceTracer(this.logger, "Preprocessing events", {
      properties: {
        type: this.eventType,
        subType: this.eventSubType,
      },
    });
  }

  endPerformanceTracerEvents() {
    this.__performanceLoggerEvents?.endPerformanceTrace(
      { threshold: this.#config.thresholdLoggingEventProcessing },
      {
        eventType: this.#eventType,
        eventSubType: this.#eventSubType,
      }
    );
  }

  endPerformanceTracerPeriodicEvents() {
    this.__performanceLoggerPeriodicEvents?.endPerformanceTrace(
      { threshold: this.#config.thresholdLoggingEventProcessing },
      {
        eventType: this.#eventType,
        eventSubType: this.#eventSubType,
      }
    );
  }

  endPerformanceTracerPreprocessing() {
    this.__performanceLoggerPreprocessing?.endPerformanceTrace(
      { threshold: this.#config.thresholdLoggingEventProcessing },
      {
        eventType: this.#eventType,
        eventSubType: this.#eventSubType,
      }
    );
  }

  logTimeExceededAndPublishContinue(iterationCounter) {
    this.logger.info("Exiting event queue processing as max time exceeded - but broadcast to trigger processing", {
      eventType: this.#eventType,
      eventSubType: this.#eventSubType,
      iterationCounter,
    });
    this.#eventSchedulerInstance.scheduleEvent(
      this.__context.tenant,
      this.#eventType,
      this.#eventSubType,
      this.#namespace,
      new Date(Date.now() + 5 * 1000) // add some offset to make sure all locks are released
    );
  }

  logStartMessage() {
    this.logger.info("Processing queue event", {
      numberClusterEntries: Object.keys(this.eventProcessingMap).length,
      eventType: this.#eventType,
      eventSubType: this.#eventSubType,
    });
  }

  /**
   * This function will be called for every event which should to be processed. Within this function basic validations
   * should be done, e.g. is the event still valid and should be processed. Also, this step should be used to gather the
   * required data for the clustering step. Keep in mind that this function will be called for every event and not once
   * for all events. Mass data select should be done later (beforeProcessingEvents).
   * If no payload is returned the status will be set to done. Transaction is available with this.tx;
   * this transaction will always be rollbacked so do not use this transaction persisting data.
   * @param {Object} queueEntry which has been selected from event queue table and been modified by modifyQueueEntry
   * @returns {Promise<Object>} payload which is needed for clustering the events.
   */
  async checkEventAndGeneratePayload(queueEntry) {
    return queueEntry.payload;
  }

  /**
   * This function will be called for every event which should to be processed. This functions sets for every event
   * the payload which will be passed to the clustering functions.
   * @param {Object} queueEntry which has been selected from event queue table and been modified by modifyQueueEntry
   * @param {Object} payload which is the result of checkEventAndGeneratePayload
   */
  addEventWithPayloadForProcessing(queueEntry, payload) {
    if (!this.__queueEntriesMap[queueEntry.ID]) {
      this.logger.error(
        "The supplied queueEntry has not been selected before and should not be processed. Entry will not be processed.",
        {
          eventType: this.#eventType,
          eventSubType: this.#eventSubType,
          queueEntryId: queueEntry.ID,
        }
      );
      return;
    }
    this.#queueEntriesWithPayloadMap[queueEntry.ID] = {
      queueEntry,
      payload,
    };
  }

  /**
   * This function sets the status of an queueEntry to done
   * @param {Object} queueEntry which has been selected from event queue table and been modified by modifyQueueEntry
   */
  setStatusToDone(queueEntry) {
    this.logger.debug("setting status for queueEntry to done", {
      id: queueEntry.ID,
      eventType: this.#eventType,
      eventSubType: this.#eventSubType,
    });
    this.#determineAndAddEventStatusToMap(queueEntry.ID, EventProcessingStatus.Done);
  }

  /**
   * This function allows to cluster multiple events so that they will be processed together. By default, there is no
   * clustering happening. Therefore, the cluster key is the ID of the event. If an alternative clustering is needed
   * this function should be overwritten. For every cluster-key the function processEvent will be called once.
   * This can be useful for e.g. multiple tasks have been scheduled and always the same user should be informed.
   * In this case the events should be clustered together and only one mail should be sent.
   */
  async clusterQueueEntries(queueEntriesWithPayloadMap) {
    Object.entries(queueEntriesWithPayloadMap).forEach(([key, { queueEntry, payload }]) => {
      this.addEntryToProcessingMap(key, queueEntry, payload);
    });
  }

  /**
   * This function allows to add entries to the process map. This function is needed if the function clusterQueueEntries
   * is redefined. For each entry in the processing map the processEvent function will be called once.
   * @param {String} key key for event
   * @param {Object} queueEntry queueEntry which should be clustered with this key
   * @param {Object} payload payload which should be clustered with this key
   */
  addEntryToProcessingMap(key, queueEntry, payload) {
    this.logger.debug("add entry to processing map", {
      key,
      queueEntry,
      eventType: this.#eventType,
      eventSubType: this.#eventSubType,
    });
    this.__eventProcessingMap[key] = this.__eventProcessingMap[key] ?? {
      queueEntries: [],
      payload,
    };
    this.__eventProcessingMap[key].queueEntries.push(queueEntry);
  }

  /**
   * This function sets the status of multiple events to a given status. If the structure of queueEntryProcessingStatusTuple
   * is not as expected all events will be set to error. The function respects the config transactionMode. If
   * transactionMode is isolated the status will be written to a dedicated map and returned afterwards to handle concurrent
   * event processing.
   * @param {Array} queueEntries which has been selected from event queue table and been modified by modifyQueueEntry
   * @param {Array<Object>} queueEntryProcessingStatusTuple Array of tuple <queueEntryId, processingStatus>
   * @param {boolean} returnMap Allows the function to allow the result as map
   * @return {Object} statusMap Map which contains all events for which a status has been set so far
   */
  setEventStatus(queueEntries, queueEntryProcessingStatusTuple, returnMap = false) {
    this.logger.debug("setting event status for entries", {
      queueEntryProcessingStatusTuple: JSON.stringify(queueEntryProcessingStatusTuple),
      eventType: this.#eventType,
      eventSubType: this.#eventSubType,
    });
    const statusMap = this.commitOnEventLevel || returnMap ? {} : this.__statusMap;
    const errorHandler = (error) => {
      queueEntries.forEach((queueEntry) =>
        this.#determineAndAddEventStatusToMap(queueEntry.ID, EventProcessingStatus.Error, statusMap)
      );
      this.logger.error(
        "The supplied status tuple doesn't have the required structure. Setting all entries to error.",
        ...[
          error,
          {
            eventType: this.#eventType,
            eventSubType: this.#eventSubType,
          },
        ].filter((a) => a)
      );
    };

    if (!queueEntryProcessingStatusTuple) {
      errorHandler();
      return statusMap;
    }

    try {
      queueEntryProcessingStatusTuple.forEach(([id, processingStatus]) =>
        this.#determineAndAddEventStatusToMap(id, processingStatus, statusMap)
      );
    } catch (error) {
      errorHandler(error);
    }
    return statusMap;
  }

  /**
   * This function allows to modify a select queueEntry (event) before processing. By default, the payload of the event
   * is parsed. The return value of the function is ignored, it's required to modify the reference which is passed into
   * the function.
   * @param {Object} queueEntry which has been selected from event queue table
   */
  modifyQueueEntry(queueEntry) {
    try {
      queueEntry.payload = JSON.parse(queueEntry.payload);
    } catch {
      /* empty */
    }
    try {
      queueEntry.context = JSON.parse(queueEntry.context);
    } catch {
      /* empty */
    }
  }

  #determineAndAddEventStatusToMap(id, statusOrUpdateData, statusMap = this.__statusMap) {
    if (typeof statusOrUpdateData === "number") {
      statusOrUpdateData = { status: statusOrUpdateData };
    }

    if (!statusMap[id]) {
      statusMap[id] = statusOrUpdateData;
      return;
    }
    if ([EventProcessingStatus.Error, EventProcessingStatus.Exceeded].includes(statusMap[id].status)) {
      // NOTE: worst aggregation --> if already error|exceeded keep this state
      return;
    }
    if (statusMap[id].status >= 0) {
      statusMap[id] = { status: statusOrUpdateData };
    }
  }

  handleErrorDuringProcessing(error, queueEntries) {
    queueEntries = Array.isArray(queueEntries) ? queueEntries : [queueEntries];
    this.logger.error(
      "Caught error during event processing - setting queue entry to error. Please catch your promises/exceptions",
      error,
      {
        eventType: this.#eventType,
        eventSubType: this.#eventSubType,
        queueEntriesIds: queueEntries.map(({ ID }) => ID),
      }
    );
    queueEntries.forEach((queueEntry) =>
      this.#determineAndAddEventStatusToMap(queueEntry.ID, EventProcessingStatus.Error)
    );
    return Object.fromEntries(queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Error]));
  }

  handleErrorDuringPeriodicEventProcessing(error, queueEntry) {
    this.logger.error("Caught error during event periodic processing. Please catch your promises/exceptions.", error, {
      eventType: this.#eventType,
      eventSubType: this.#eventSubType,
      queueEntryId: queueEntry.ID,
    });
  }

  async setPeriodicEventStatus(queueEntryIds, status) {
    await this.tx.run(
      UPDATE.entity(this.#config.tableNameEventQueue)
        .set({
          status: status,
        })
        .where({
          ID: queueEntryIds,
        })
    );
  }

  #normalizeStatusMap(statusMap) {
    const originalMap = {};
    for (const [id, entry] of Object.entries(statusMap)) {
      originalMap[id] = entry;
      const result = {};
      if (typeof entry === "number") {
        result.status = entry;
      } else if (typeof entry === "object") {
        for (const fieldName of ALLOWED_FIELDS_FOR_UPDATE) {
          if (fieldName in entry) {
            result[fieldName] = entry[fieldName];
          }
        }
      }
      statusMap[id] = result;
    }
    return originalMap;
  }

  /**
   * This function validates for all selected events one status has been submitted. It's also validated that only for
   * selected events a status has been submitted. Persisting the status of events is done in a dedicated database tx.
   * The function accepts no arguments as there are dedicated functions to set the status of events (e.g. setEventStatus)
   */
  async persistEventStatus(tx, { skipChecks, statusMap = this.__statusMap } = {}) {
    this.logger.debug("entering persistEventStatus", {
      eventType: this.#eventType,
      eventSubType: this.#eventSubType,
    });
    const originalStatusMap = this.#normalizeStatusMap(statusMap);
    this.#ensureOnlySelectedQueueEntries(statusMap);
    if (!skipChecks) {
      this.#ensureEveryQueueEntryHasStatus();
    }
    this.#ensureEveryStatusIsAllowed(statusMap);
    return await trace(this.baseContext, "persist-event-status", async () => {
      this.logger.debug("persistEventStatus for entries", {
        eventType: this.#eventType,
        eventSubType: this.#eventSubType,
        statusMap,
      });
      const ts = new Date().toISOString();
      const updateData = Object.entries(statusMap).reduce((result, [id, data]) => {
        const key = ALLOWED_FIELDS_FOR_UPDATE.map((name) => [name, data[name]])
          .flat()
          .join("##");

        result[key] ??= { data, ids: [] };
        result[key].ids.push(id);
        return result;
      }, {});

      // TODO: schedule open events???
      for (const { ids, data } of Object.values(updateData)) {
        let startAfter;

        if (!("status" in data)) {
          this.logger.error("can't find status value in return value of event-processing. Setting event to done", {
            ids,
            // NOTE: use first id as same return values are clustered
            eventReturnValue: originalStatusMap[ids[0]],
          });
          continue;
        }

        for (const id of ids) {
          this.__commitedStatusMap[id] = data.status;
          delete this.__notCommitedStatusMap[id];
        }

        if ([EventProcessingStatus.Error, EventProcessingStatus.Open].includes(data.status)) {
          startAfter = new Date(Date.now() + this.#retryFailedAfter);
          this.#eventSchedulerInstance.scheduleEvent(
            this.__context.tenant,
            this.#eventType,
            this.#eventSubType,
            this.#namespace,
            startAfter
          );
        }

        await tx.run(
          UPDATE.entity(this.#config.tableNameEventQueue)
            .set({
              ...data,
              lastAttemptTimestamp: ts,
              ...(data.status === EventProcessingStatus.Error ? { startAfter: startAfter.toISOString() } : {}),
            })
            .where("ID IN", ids)
        );
      }
    });
  }

  #ensureEveryQueueEntryHasStatus() {
    this.__queueEntries.forEach((queueEntry) => {
      if (
        queueEntry.ID in this.__statusMap ||
        queueEntry.ID in this.__commitedStatusMap ||
        queueEntry.ID in this.__outdatedEventMap
      ) {
        return;
      }
      this.logger.error("Missing status for selected event entry. Setting status to done", {
        eventType: this.#eventType,
        eventSubType: this.#eventSubType,
        queueEntry,
      });
      this.#determineAndAddEventStatusToMap(queueEntry.ID, EventProcessingStatus.Done);
    });
  }

  #ensureEveryStatusIsAllowed(statusMap) {
    Object.entries(statusMap).forEach(([queueEntryId, { status }]) => {
      if (
        [
          EventProcessingStatus.Open,
          EventProcessingStatus.Done,
          EventProcessingStatus.Error,
          EventProcessingStatus.Exceeded,
        ].includes(status)
      ) {
        return;
      }

      if (!status) {
        return;
      }

      this.logger.error("Not allowed event status returned. Only Open, Done, Error is allowed!", {
        eventType: this.#eventType,
        eventSubType: this.#eventSubType,
        queueEntryId,
        status: statusMap[queueEntryId].status,
      });
      delete statusMap[queueEntryId];
    });
  }

  #ensureOnlySelectedQueueEntries(statusMap) {
    Object.keys(statusMap).forEach((queueEntryId) => {
      if (this.#selectedEventMap[queueEntryId]) {
        return;
      }

      this.logger.error(
        "Status reported for event queue entry which haven't be selected before. Removing the status.",
        {
          eventType: this.#eventType,
          eventSubType: this.#eventSubType,
          queueEntryId,
        }
      );
      delete statusMap[queueEntryId];
    });
  }

  handleErrorDuringClustering(error) {
    this.logger.error("Error during clustering of events - setting all queue entries to error.", error, {
      eventType: this.#eventType,
      eventSubType: this.#eventSubType,
    });
    this.__queueEntries.forEach((queueEntry) => {
      this.#determineAndAddEventStatusToMap(queueEntry.ID, EventProcessingStatus.Error);
    });
  }

  handleErrorTx(error) {
    this.logger.error("Error in commit|rollback transaction, check handlers and constraints!", error, {
      eventType: this.#eventType,
      eventSubType: this.#eventSubType,
    });
    this.__queueEntries.forEach((queueEntry) => {
      this.#determineAndAddEventStatusToMap(queueEntry.ID, EventProcessingStatus.Error);
    });
  }

  handleInvalidPayloadReturned(queueEntry) {
    this.logger.error(
      "Undefined payload is not allowed. If status should be done, nulls needs to be returned" +
        " - setting queue entry to error",
      {
        eventType: this.#eventType,
        eventSubType: this.#eventSubType,
      }
    );
    this.#determineAndAddEventStatusToMap(queueEntry.ID, EventProcessingStatus.Error);
  }

  /**
   * This function selects all relevant events based on the eventType and eventSubType supplied through the constructor
   * during initialization of the class.
   * Relevant Events for selection are: open events, error events if the number retry attempts has not been succeeded or
   * events which are in progress for longer than 30 minutes.
   * @return {Promise<Array<Object>>} all relevant events for processing for the given eventType and eventSubType
   */
  async getQueueEntriesAndSetToInProgress() {
    let result = [];
    const baseDate = Date.now();
    const refDateStartAfter = new Date(baseDate + this.#config.runInterval * 1.2);
    await executeInNewTransaction(this.__baseContext, "eventQueue-getQueueEntriesAndSetToInProgress", async (tx) => {
      const entries = await tx.run(
        SELECT.from(this.#config.tableNameEventQueue)
          .forUpdate({ wait: this.#config.forUpdateTimeout })
          .limit(this.selectMaxChunkSize)
          .where(
            "type =",
            this.#eventType,
            "AND subType=",
            this.#eventSubType,
            "AND namespace =",
            this.#namespace,
            "AND ( startAfter IS NULL OR startAfter <=",
            refDateStartAfter.toISOString(),
            " ) AND ( status =",
            EventProcessingStatus.Open,
            "AND ( lastAttemptTimestamp <=",
            this.startTime.toISOString(),
            ...(this.isPeriodicEvent
              ? [
                  "OR lastAttemptTimestamp IS NULL ) OR ( status =",
                  EventProcessingStatus.InProgress,
                  "AND lastAttemptTimestamp <=",
                  new Date(baseDate - this.#eventConfig.keepAliveMaxInProgressTime * 1000).toISOString(),
                  ") )",
                ]
              : [
                  "OR lastAttemptTimestamp IS NULL ) OR ( status =",
                  EventProcessingStatus.Error,
                  "AND lastAttemptTimestamp <=",
                  this.startTime.toISOString(),
                  ") OR ( status =",
                  EventProcessingStatus.InProgress,
                  "AND lastAttemptTimestamp <=",
                  new Date(baseDate - this.#eventConfig.keepAliveMaxInProgressTime * 1000).toISOString(),
                  ") )",
                ])
          )
          .orderBy("createdAt", "ID")
      );

      if (!entries.length) {
        this.logger.debug("no entries available for processing", {
          eventType: this.#eventType,
          eventSubType: this.#eventSubType,
        });
        this.__emptyChunkSelected = true;
        return;
      }

      const { exceededTries, openEvents, exceededTriesExceeded, delayedEvents } = this.#clusterEvents(
        entries,
        refDateStartAfter
      );
      const eventsForProcessing = openEvents
        .concat(exceededTriesExceeded)
        .concat(this.#isPeriodic ? [] : exceededTries);
      this.#selectedEventMap = arrayToFlatMap(eventsForProcessing);
      if (!this.#isPeriodic && exceededTries.length) {
        this.#eventsWithExceededTries = exceededTries;
      }
      if (exceededTriesExceeded.length) {
        this.#exceededTriesExceeded = exceededTriesExceeded;
      }
      this.#handleDelayedEvents(delayedEvents);

      result = openEvents;
      this.logger[eventsForProcessing.length && !this.isPeriodicEvent ? "info" : "debug"](
        "Selected event queue entries for processing",
        {
          openEvents: openEvents.length,
          ...(delayedEvents.length && { delayedEvents: delayedEvents.length }),
          ...(exceededTries.length && { exceededTries: exceededTries.length }),
          eventType: this.#eventType,
          eventSubType: this.#eventSubType,
        }
      );

      if (this.#isPeriodic && exceededTries.length) {
        await tx.run(
          UPDATE.entity(this.#config.tableNameEventQueue)
            .set({
              status: EventProcessingStatus.Error,
              lastAttemptTimestamp: new Date(),
            })
            .where(
              "ID IN",
              exceededTries.map(({ ID }) => ID)
            )
        );
      }

      if (!eventsForProcessing.length) {
        this.__emptyChunkSelected = true;
        return;
      }

      const isoTimestamp = new Date().toISOString();
      await tx.run(
        UPDATE.entity(this.#config.tableNameEventQueue)
          .with({
            status: EventProcessingStatus.InProgress,
            lastAttemptTimestamp: isoTimestamp,
            attempts: { "+=": 1 },
          })
          .where(
            "ID IN",
            eventsForProcessing.map(({ ID }) => ID)
          )
      );
      eventsForProcessing.forEach((entry) => {
        entry.lastAttemptTimestamp = isoTimestamp;
        // NOTE: empty payloads are supported on DB-Level.
        // Behaviour of event queue is: null as payload is treated as obsolete/done
        // For supporting this convert null to empty string --> "" as payload will be processed normally
        if (entry.payload === null) {
          entry.payload = "";
        }
      });
      this.__queueEntries = result;
      this.__queueEntriesMap = arrayToFlatMap(result);
      this.__notCommitedStatusMap = arrayToFlatMap(result);
      this.#etagMap = Object.fromEntries(result.map((event) => [event.ID, event.lastAttemptTimestamp]));

      if (this.#isPeriodic && this.#eventConfig.lastSuccessfulRunTimestamp) {
        this.#lastSuccessfulRunTimestamp = await this.#selectLastSuccessfulPeriodicTimestamp(tx);
      }
    });
    return result;
  }

  async #selectLastSuccessfulPeriodicTimestamp() {
    const entry = await SELECT.one
      .from(this.#config.tableNameEventQueue)
      .where({
        type: this.#eventType,
        subType: this.#eventSubType,
        status: EventProcessingStatus.Done,
      })
      .columns("max (lastAttemptTimestamp) as lastAttemptsTs");
    return entry.lastAttemptsTs;
  }

  #handleDelayedEvents(delayedEvents) {
    for (const delayedEvent of delayedEvents) {
      this.#eventSchedulerInstance.scheduleEvent(
        this.__context.tenant,
        this.#eventType,
        this.#eventSubType,
        delayedEvent.namespace,
        delayedEvent.startAfter
      );
    }
  }

  #clusterEvents(events, refDateStartAfter) {
    const refDate = new Date(refDateStartAfter.getTime() - this.#config.runInterval * 1.2 + EVENT_START_AFTER_HEADROOM);
    return events.reduce(
      (result, event) => {
        if (event.attempts === this.__retryAttempts + TRIES_FOR_EXCEEDED_EVENTS) {
          result.exceededTriesExceeded.push(event);
        } else if (event.attempts >= this.__retryAttempts) {
          result.exceededTries.push(event);
        } else if (this.#isDelayedEvent(event, refDate)) {
          result.delayedEvents.push(event);
        } else {
          result.openEvents.push(event);
        }
        return result;
      },
      { exceededTries: [], openEvents: [], exceededTriesExceeded: [], delayedEvents: [] }
    );
  }

  #isDelayedEvent(event, refDate) {
    if (!event.startAfter) {
      return false;
    }
    event.startAfter = new Date(event.startAfter);
    return !(refDate >= event.startAfter);
  }

  async handleExceededEvents() {
    await this.#handleExceededTriesExceeded();
    if (!this.#eventsWithExceededTries.length) {
      return;
    }

    return await trace(this.baseContext, "handle-exceeded-events", async () => {
      for (const exceededEvent of this.#eventsWithExceededTries) {
        await executeInNewTransaction(
          this.__baseContext,
          `eventQueue-handleExceededEvents-${this.#eventType}##${this.#eventSubType}`,
          async (tx) => {
            try {
              this.processEventContext = tx.context;
              this.modifyQueueEntry(exceededEvent);
              await this.hookForExceededEvents({ ...exceededEvent });
              this.logger.warn("The retry attempts for the following events are exceeded", {
                eventType: this.#eventType,
                eventSubType: this.#eventSubType,
                retryAttempts: this.__retryAttempts,
                queueEntriesId: exceededEvent.ID,
                currentAttempt: exceededEvent.attempts,
              });
              await this.#persistEventQueueStatusForExceeded(this.tx, [exceededEvent], EventProcessingStatus.Exceeded);
            } catch (err) {
              this.logger.error(
                "Caught error during hook for exceeded events - setting queue entry to error. Please catch your promises/exceptions.",
                err,
                {
                  eventType: this.#eventType,
                  eventSubType: this.#eventSubType,
                  retryAttempts: this.__retryAttempts,
                  queueEntriesId: exceededEvent.ID,
                  currentAttempt: exceededEvent.attempts,
                }
              );
              await tx.rollback();
              await executeInNewTransaction(this.__baseContext, "error-hookForExceededEvents", async (tx) =>
                this.#persistEventQueueStatusForExceeded(tx, [exceededEvent], EventProcessingStatus.Error)
              );
            }
          }
        );
      }
    });
  }

  async #handleExceededTriesExceeded() {
    if (this.#exceededTriesExceeded.length) {
      this.logger.error("Event hook failure exceeded, status set to 'exceeded' without invoking hook again!", {
        eventType: this.#eventType,
        eventSubType: this.#eventSubType,
        queueEntriesIds: this.#eventsWithExceededTries.map(({ ID }) => ID),
      });
      await executeInNewTransaction(this.__baseContext, "exceededTriesExceeded", async (tx) => {
        await this.#persistEventQueueStatusForExceeded(tx, this.#exceededTriesExceeded, EventProcessingStatus.Exceeded);
      });
    }
  }

  async #persistEventQueueStatusForExceeded(tx, events, status) {
    const statusMap = this.setEventStatus(
      events,
      events.map((e) => [e.ID, status]),
      true
    );
    await this.persistEventStatus(tx, { statusMap, skipChecks: true });
  }

  /**
   * This function enables the possibility to execute custom actions for events for which the retry attempts have been
   * exceeded. As always a valid transaction is available with this.tx. This transaction will be committed after the
   * execution of this function.
   * @param {Object} exceededEvent exceeded event queue entry
   */
  // eslint-disable-next-line no-unused-vars
  async hookForExceededEvents(exceededEvent) {}

  /**
   * This function serves the purpose of mass enabled preloading data for processing the events which are added with
   * the function 'addEventWithPayloadForProcessing'. This function is called after the clustering and before the
   * process-events-steps. The event data is available with this.eventProcessingMap.
   */
  // eslint-disable-next-line no-unused-vars
  async beforeProcessingEvents() {}

  async isOutdatedAndKeepAlive() {
    if (this.__keepAliveViolated) {
      return true;
    }
  }

  continuesKeepAlive() {
    if (Date.now() - this.lockAcquiredTime.getTime() >= this.#eventConfig.keepAliveInterval * 1000) {
      trace(this.baseContext, "keepAlive-between-iterations", async () => {
        await this.#renewDistributedLock();
      }).catch((err) => this.logger.error("renewing lock between intervals failed!", err));
    }
    this.#keepAliveRunner.start(async () => {
      await this.#currentKeepAlivePromise;
      this.#currentKeepAlivePromise = executeInNewTransaction(this.__baseContext, "keepAlive", async (tx) => {
        await trace(tx.context, "keepAlive", async () => {
          const ids = Object.values(this.__notCommitedStatusMap).map(({ ID }) => ID);
          if (!ids.length) {
            return;
          }
          this.logger.info("keep alive triggered for events", { numberOfEvents: ids.length });
          await this.#renewDistributedLock();

          // we make sure to always keep alive the global event lock; but we do not modify the events itself anymore
          if (this.__keepAliveViolated) {
            return;
          }

          const events = await tx.run(
            SELECT.from(this.#config.tableNameEventQueue)
              .forUpdate({ wait: this.#config.forUpdateTimeout })
              .where("ID IN", ids, "AND status =", EventProcessingStatus.InProgress)
              .columns("ID", "lastAttemptTimestamp")
          );

          const newTs = new Date().toISOString();
          const outdatedEvents = [];
          const validEventIds = [];
          for (const event of events) {
            const etag = this.#etagMap[event.ID];
            if (etag !== event.lastAttemptTimestamp) {
              outdatedEvents.push(event);
              this.__keepAliveViolated = true;
            } else {
              validEventIds.push(event.ID);
              this.#etagMap[event.ID] = newTs;
            }
          }

          if (outdatedEvents.length) {
            // NOTE: we stop right here something is really off
            outdatedEvents.forEach(({ ID: queueEntryId }) => {
              delete this.__queueEntriesMap[queueEntryId];
              this.__outdatedEventMap[queueEntryId] = 1;
            });

            this.logger.warn(
              "Event data has been modified on the database. Further processing skipped. Parallel running events might have already commited status!",
              {
                eventType: this.#eventType,
                eventSubType: this.#eventSubType,
                queueEntriesIds: outdatedEvents.map(({ ID }) => ID),
              }
            );
          }

          if (validEventIds.length) {
            await tx.run(
              UPDATE.entity(this.#config.tableNameEventQueue)
                .set("lastAttemptTimestamp =", newTs)
                .where("ID IN", validEventIds)
            );
            // NOTE: update internal map after tx is successfully commited!
            tx.context.on("succeeded", () => {
              for (const event of events) {
                const etag = this.#etagMap[event.ID];
                if (etag === event.lastAttemptTimestamp) {
                  this.#etagMap[event.ID] = newTs;
                }
              }
            });
          }
          this.logger.info("keep alive finished!", { numberOfEvents: ids.length });
        });
      }).catch((err) => {
        this.logger.error("keep alive handling failed!", err);
      });
      await this.#currentKeepAlivePromise;
    });
  }

  async acquireDistributedLock() {
    if (this.concurrentEventProcessing) {
      return true;
    }

    return await trace(this.baseContext, "acquire-lock", async () => {
      const lockAcquired = await distributedLock.acquireLock(
        this.__context,
        [this.#namespace, this.#eventType, this.#eventSubType].join("##"),
        { keepTrackOfLock: true, expiryTime: this.#eventConfig.keepAliveMaxInProgressTime * 1000 }
      );
      if (!lockAcquired) {
        this.logger.debug("no lock available, exit processing", {
          type: this.#eventType,
          subType: this.#eventSubType,
        });
        return false;
      }
      this.__lockAcquired = true;
      return true;
    });
  }

  async #renewDistributedLock() {
    if (this.concurrentEventProcessing) {
      return true;
    }

    const lockAcquired = await distributedLock.renewLock(
      this.__context,
      [this.#eventType, this.#eventSubType].join("##"),
      { expiryTime: this.#eventConfig.keepAliveMaxInProgressTime * 1000 }
    );
    if (!lockAcquired) {
      this.logger.error("renewing distributed lock failed!", {
        type: this.#eventType,
        subType: this.#eventSubType,
      });
      return false;
    }
    this.lockAcquiredTime = new Date();
    return true;
  }

  async handleReleaseLock() {
    if (!this.__lockAcquired) {
      return;
    }
    try {
      await trace(this.baseContext, "release-lock", async () => {
        await distributedLock.releaseLock(
          this.context,
          [this.#namespace, this.#eventType, this.#eventSubType].join("##")
        );
      });
    } catch (err) {
      this.logger.error("Releasing distributed lock failed.", err);
    }
  }

  #calculateCronDates() {
    if (!this.#eventConfig.cron) {
      return null;
    }

    // NOTE: do not pass current date as we always want to calc. a future date
    const cronExpression = CronExpressionParser.parse(this.#eventConfig.cron, {
      tz: this.#eventConfig.tz,
    });
    return cronExpression.next();
  }

  async scheduleNextPeriodEvent(queueEntry) {
    const intervalInMs = this.#eventConfig.cron ? null : this.#eventConfig.interval * 1000;
    const next = this.#calculateCronDates();
    let newStartAfter;

    if (this.#eventConfig.cron) {
      newStartAfter = next.getTime() + this.#calculateRandomOffset();
    } else {
      newStartAfter = new Date(queueEntry.startAfter).getTime() + intervalInMs + this.#calculateRandomOffset();
    }

    const newEvent = {
      type: this.#eventType,
      subType: this.#eventSubType,
      namespace: this.#eventConfig.namespace,
      startAfter: new Date(newStartAfter),
    };
    const { relative } = this.#eventSchedulerInstance.calculateOffset(
      this.#eventType,
      this.#eventSubType,
      newEvent.startAfter
    );

    // more than one interval behind - shift tick to keep up
    // cron package always calc the next future date --> not needed for crone
    if (relative < 0 && Math.abs(relative) >= intervalInMs) {
      const plannedStartAfter = newEvent.startAfter;
      newEvent.startAfter = new Date(Date.now() + 5 * 1000);
      this.logger.info("interval adjusted because shifted more than one interval", {
        eventType: this.#eventType,
        eventSubType: this.#eventSubType,
        plannedStartAfter,
        newStartAfter: newEvent.startAfter,
      });
    }

    this.tx._skipEventQueueBroadcase = true;
    await this.tx.run(
      INSERT.into(this.#config.tableNameEventQueue).entries({
        ...newEvent,
        startAfter: newEvent.startAfter.toISOString(),
      })
    );
    this.tx._skipEventQueueBroadcase = false;
    if (intervalInMs < this.#config.runInterval * 1.5) {
      this.#handleDelayedEvents([newEvent]);
      const { relative: relativeAfterSchedule } = this.#eventSchedulerInstance.calculateOffset(
        this.#eventType,
        this.#eventSubType,
        newEvent.startAfter
      );
      // NOTE: can only happen for interval events: next tick is already behind schedule --> execute direct
      if (relativeAfterSchedule <= 0) {
        this.logger.info("running behind schedule - executing next tick immediately", {
          eventType: this.#eventType,
          eventSubType: this.#eventSubType,
          newStartAfter: newEvent.startAfter,
        });
        return true;
      }
    }
  }

  #calculateRandomOffset() {
    const offset = this.#eventConfig.randomOffset ?? this.#config.randomOffsetPeriodicEvents;
    if (!offset) {
      return 0;
    }

    return Math.floor(Math.random() * offset) * 1000;
  }

  async handleDuplicatedPeriodicEventEntry(queueEntries) {
    this.logger.error("More than one open events for the same configuration which is not allowed!", {
      eventType: this.#eventType,
      eventSubType: this.#eventSubType,
      queueEntriesIds: queueEntries.map(({ ID }) => ID),
    });

    let queueEntryToUse;
    const obsoleteEntries = [];
    for (const queueEntry of queueEntries) {
      if (!queueEntryToUse) {
        queueEntryToUse = queueEntry;
        continue;
      }

      if (queueEntryToUse.startAfter <= queueEntry.queueEntry) {
        obsoleteEntries.push(queueEntryToUse);
        queueEntryToUse = queueEntry;
      } else {
        obsoleteEntries.push(queueEntry);
      }
    }
    await this.setPeriodicEventStatus(
      obsoleteEntries.map(({ ID }) => ID),
      EventProcessingStatus.Done
    );
    return queueEntryToUse;
  }

  /**
   * Asynchronously gets the timestamp of the last successful run.
   *
   * @returns {Promise<string|null>} A Promise that resolves to a string representation of the timestamp
   * of the last successful run (in ISO 8601 format: YYYY-MM-DDTHH:mm:ss.sss),
   * or null if there has been no successful run yet.
   *
   * @example
   * const timestamp = await instance.getLastSuccessfulRunTimestamp();
   * console.log(timestamp);  // Outputs: 2023-12-07T09:15:44.237
   *
   * @throws {Error} If an error occurs while fetching the timestamp.
   */
  async getLastSuccessfulRunTimestamp() {
    if (!this.#isPeriodic) {
      return null;
    }
    if (this.#lastSuccessfulRunTimestamp === undefined) {
      this.#lastSuccessfulRunTimestamp = await this.#selectLastSuccessfulPeriodicTimestamp();
    }

    return this.#lastSuccessfulRunTimestamp;
  }

  statusMapContainsError(statusMap) {
    return Object.values(statusMap).includes(EventProcessingStatus.Error);
  }

  clearEventProcessingContext() {
    this.__processContext = null;
    this.__processTx = null;
  }

  stopKeepAlive() {
    this.#keepAliveRunner.stop();
  }

  get keepAlivePromise() {
    return this.#currentKeepAlivePromise;
  }

  get logger() {
    return this.__logger ?? this.__baseLogger;
  }

  set logger(value) {
    this.__logger = value;
  }

  get queueEntriesWithPayloadMap() {
    return this.#queueEntriesWithPayloadMap;
  }

  get eventProcessingMap() {
    return this.__eventProcessingMap;
  }

  get parallelEventProcessing() {
    return this.__parallelEventProcessing;
  }

  get concurrentEventProcessing() {
    return this.__concurrentEventProcessing;
  }

  set processEventContext(context) {
    if (!context) {
      this.__processContext = null;
      this.__processTx = null;
      return;
    }
    this.__processContext = context;
    this.__processTx = cds.tx(context);
  }

  get tx() {
    if (!this.__txUsageAllowed && this.__parallelEventProcessing > 1) {
      throw EventQueueError.wrongTxUsage(this.#eventType, this.#eventSubType);
    }
    return this.__processTx ?? this.__tx;
  }

  get context() {
    if (!this.__txUsageAllowed && this.__parallelEventProcessing > 1) {
      throw EventQueueError.wrongTxUsage(this.#eventType, this.#eventSubType);
    }
    return this.__processContext ?? this.__context;
  }

  get baseContext() {
    return this.__baseContext;
  }

  get commitOnEventLevel() {
    return this.__transactionMode === TransactionMode.isolated;
  }

  get transactionMode() {
    return this.__transactionMode;
  }

  get eventType() {
    return this.#eventType.replace(SUFFIX_PERIODIC, "");
  }

  get rawEventType() {
    return this.#eventType;
  }

  get eventSubType() {
    return this.#eventSubType;
  }

  get emptyChunkSelected() {
    return this.__emptyChunkSelected;
  }

  get selectNextChunk() {
    return this.__selectNextChunk;
  }

  get selectMaxChunkSize() {
    return this.__selectMaxChunkSize;
  }

  set txUsageAllowed(value) {
    this.__txUsageAllowed = value;
  }

  getContextForEventProcessing(key) {
    return this.__txMap[key]?.context;
  }

  getTxForEventProcessing(key) {
    return this.__txMap[key];
  }

  setShouldRollbackTransaction(key) {
    this.__txRollback[key] = true;
  }

  shouldRollbackTransaction(key) {
    return this.__txRollback[key];
  }

  setTxForEventProcessing(key, tx) {
    this.__txMap[key] = tx;
  }

  get isPeriodicEvent() {
    return this.#eventConfig.isPeriodic;
  }

  get eventConfig() {
    return this.#eventConfig;
  }

  get lockAcquiredTime() {
    return this.#eventConfig.lockAcquiredTime;
  }

  get startTime() {
    return this.#eventConfig.startTime;
  }

  set lockAcquiredTime(value) {
    this.#eventConfig.lockAcquiredTime = value;
  }

  get inheritTraceContext() {
    return this.#eventConfig.inheritTraceContext;
  }

  get namespace() {
    return this.#namespace;
  }
}

module.exports = EventQueueProcessorBase;
