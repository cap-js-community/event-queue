"use strict";

const cds = require("@sap/cds");

const { executeInNewTransaction, TriggerRollback } = require("./shared/cdsHelper");
const { EventProcessingStatus, TransactionMode } = require("./constants");
const distributedLock = require("./shared/distributedLock");
const EventQueueError = require("./EventQueueError");
const { arrayToFlatMap } = require("./shared/common");
const eventQueueConfig = require("./config");
const PerformanceTracer = require("./shared/PerformanceTracer");

const IMPLEMENT_ERROR_MESSAGE = "needs to be reimplemented";
const COMPONENT_NAME = "eventQueue/EventQueueProcessorBase";

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_PARALLEL_EVENT_PROCESSING = 1;
const LIMIT_PARALLEL_EVENT_PROCESSING = 10;
const SELECT_LIMIT_EVENTS_PER_TICK = 100;
const DEFAULT_DELETE_FINISHED_EVENTS_AFTER = 0;
const DAYS_TO_MS = 24 * 60 * 60 * 1000;
const TRIES_FOR_EXCEEDED_EVENTS = 3;

class EventQueueProcessorBase {
  #eventsWithExceededTries = [];
  #exceededTriesExceeded = [];

  constructor(context, eventType, eventSubType, config) {
    this.__context = context;
    this.__baseContext = context;
    this.__tx = cds.tx(context);
    this.__baseLogger = cds.log(COMPONENT_NAME);
    this.__logger = null;
    this.__eventProcessingMap = {};
    this.__statusMap = {};
    this.__commitedStatusMap = {};
    this.__eventType = eventType;
    this.__eventSubType = eventSubType;
    this.__queueEntriesWithPayloadMap = {};
    this.__config = config ?? {};
    this.__parallelEventProcessing = this.__config.parallelEventProcessing ?? DEFAULT_PARALLEL_EVENT_PROCESSING;
    if (this.__parallelEventProcessing > LIMIT_PARALLEL_EVENT_PROCESSING) {
      this.__parallelEventProcessing = LIMIT_PARALLEL_EVENT_PROCESSING;
    }
    // NOTE: keep the feature, this might be needed again
    this.__concurrentEventProcessing = false;
    this.__startTime = this.__config.startTime ?? new Date();
    this.__retryAttempts = this.__config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    this.__selectMaxChunkSize = this.__config.selectMaxChunkSize ?? SELECT_LIMIT_EVENTS_PER_TICK;
    this.__selectNextChunk = !!this.__config.checkForNextChunk;
    this.__keepalivePromises = {};
    this.__outdatedCheckEnabled = this.__config.eventOutdatedCheck ?? true;
    this.__transactionMode = this.__config.transactionMode ?? TransactionMode.isolated;
    if (this.__config.deleteFinishedEventsAfterDays) {
      this.__deleteFinishedEventsAfter =
        Number.isInteger(this.__config.deleteFinishedEventsAfterDays) && this.__config.deleteFinishedEventsAfterDays > 0
          ? this.__config.deleteFinishedEventsAfterDays
          : DEFAULT_DELETE_FINISHED_EVENTS_AFTER;
    } else {
      this.__deleteFinishedEventsAfter = DEFAULT_DELETE_FINISHED_EVENTS_AFTER;
    }
    this.__emptyChunkSelected = false;
    this.__lockAcquired = false;
    this.__txUsageAllowed = true;
    this.__txMap = {};
    this.__txRollback = {};
    this.__eventQueueConfig = eventQueueConfig.getConfigInstance();
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

  startPerformanceTracerEvents() {
    this.__performanceLoggerEvents = new PerformanceTracer(this.logger, "Processing events");
  }

  startPerformanceTracerPreprocessing() {
    this.__performanceLoggerPreprocessing = new PerformanceTracer(this.logger, "Preprocessing events");
  }

  endPerformanceTracerEvents() {
    this.__performanceLoggerEvents?.endPerformanceTrace(
      { threshold: 50 },
      {
        eventType: this.eventType,
        eventSubType: this.eventSubType,
      }
    );
  }

  endPerformanceTracerPreprocessing() {
    this.__performanceLoggerPreprocessing?.endPerformanceTrace(
      { threshold: 50 },
      {
        eventType: this.eventType,
        eventSubType: this.eventSubType,
      }
    );
  }

  logTimeExceeded(iterationCounter) {
    this.logger.info("Exiting event queue processing as max time exceeded", {
      eventType: this.eventType,
      eventSubType: this.eventSubType,
      iterationCounter,
    });
  }

  logStartMessage(queueEntries) {
    // TODO: how to handle custom fields
    this.logger.info("Processing queue event", {
      numberQueueEntries: queueEntries.length,
      eventType: this.__eventType,
      eventSubType: this.__eventSubType,
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
          eventType: this.__eventType,
          eventSubType: this.__eventSubType,
          queueEntryId: queueEntry.ID,
        }
      );
      return;
    }
    this.__queueEntriesWithPayloadMap[queueEntry.ID] = {
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
      eventType: this.__eventType,
      eventSubType: this.__eventSubType,
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
  clusterQueueEntries() {
    Object.entries(this.__queueEntriesWithPayloadMap).forEach(([key, { queueEntry, payload }]) => {
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
      eventType: this.__eventType,
      eventSubType: this.__eventSubType,
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
      eventType: this.__eventType,
      eventSubType: this.__eventSubType,
    });
    const statusMap = this.commitOnEventLevel || returnMap ? {} : this.__statusMap;
    try {
      queueEntryProcessingStatusTuple.forEach(([id, processingStatus]) =>
        this.#determineAndAddEventStatusToMap(id, processingStatus, statusMap)
      );
    } catch (error) {
      queueEntries.forEach((queueEntry) =>
        this.#determineAndAddEventStatusToMap(queueEntry.ID, EventProcessingStatus.Error, statusMap)
      );
      this.logger.error(
        `The supplied status tuple doesn't have the required structure. Setting all entries to error. Error: ${error.toString()}`,
        {
          eventType: this.__eventType,
          eventSubType: this.__eventSubType,
        }
      );
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
      return queueEntry.payload;
    }
  }

  #determineAndAddEventStatusToMap(id, processingStatus, statusMap = this.__statusMap) {
    if (!statusMap[id]) {
      statusMap[id] = processingStatus;
      return;
    }
    if ([EventProcessingStatus.Error, EventProcessingStatus.Exceeded].includes(statusMap[id])) {
      // NOTE: worst aggregation --> if already error|exceeded keep this state
      return;
    }
    if (statusMap[id] >= 0) {
      statusMap[id] = processingStatus;
    }
  }

  handleErrorDuringProcessing(error, queueEntries) {
    queueEntries = Array.isArray(queueEntries) ? queueEntries : [queueEntries];
    this.logger.error(
      `Caught error during event processing - setting queue entry to error. Please catch your promises/exceptions. Error: ${error}`,
      {
        eventType: this.__eventType,
        eventSubType: this.__eventSubType,
        queueEntriesIds: queueEntries.map(({ ID }) => ID),
      }
    );
    queueEntries.forEach((queueEntry) =>
      this.#determineAndAddEventStatusToMap(queueEntry.ID, EventProcessingStatus.Error)
    );
    return Object.fromEntries(queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Error]));
  }

  /**
   * This function validates for all selected events one status has been submitted. It's also validated that only for
   * selected events a status has been submitted. Persisting the status of events is done in a dedicated database tx.
   * The function accepts no arguments as there are dedicated functions to set the status of events (e.g. setEventStatus)
   */
  async persistEventStatus(tx, { skipChecks, statusMap = this.__statusMap } = {}) {
    this.logger.debug("entering persistEventStatus", {
      eventType: this.__eventType,
      eventSubType: this.__eventSubType,
    });
    this.#ensureOnlySelectedQueueEntries(statusMap);
    if (!skipChecks) {
      this.#ensureEveryQueueEntryHasStatus();
    }
    this.#ensureEveryStatusIsAllowed(statusMap);

    const { success, failed, exceeded, invalidAttempts } = Object.entries(statusMap).reduce(
      (result, [notificationEntityId, processingStatus]) => {
        this.__commitedStatusMap[notificationEntityId] = processingStatus;
        if (processingStatus === EventProcessingStatus.Open) {
          result.invalidAttempts.push(notificationEntityId);
        } else if (processingStatus === EventProcessingStatus.Done) {
          result.success.push(notificationEntityId);
        } else if (processingStatus === EventProcessingStatus.Error) {
          result.failed.push(notificationEntityId);
        } else if (processingStatus === EventProcessingStatus.Exceeded) {
          result.exceeded.push(notificationEntityId);
        }
        return result;
      },
      {
        success: [],
        failed: [],
        exceeded: [],
        invalidAttempts: [],
      }
    );
    this.logger.debug("persistEventStatus for entries", {
      eventType: this.__eventType,
      eventSubType: this.__eventSubType,
      invalidAttempts,
      failed,
      exceeded,
      success,
    });
    if (invalidAttempts.length) {
      await tx.run(
        UPDATE.entity(this.__eventQueueConfig.tableNameEventQueue)
          .set({
            status: EventProcessingStatus.Open,
            lastAttemptTimestamp: new Date().toISOString(),
            attempts: { "-=": 1 },
          })
          .where("ID IN", invalidAttempts)
      );
    }
    if (success.length) {
      await tx.run(
        UPDATE.entity(this.__eventQueueConfig.tableNameEventQueue)
          .set({
            status: EventProcessingStatus.Done,
            lastAttemptTimestamp: new Date().toISOString(),
          })
          .where("ID IN", success)
      );
    }
    if (failed.length) {
      await tx.run(
        UPDATE.entity(this.__eventQueueConfig.tableNameEventQueue).where("ID IN", failed).with({
          status: EventProcessingStatus.Error,
          lastAttemptTimestamp: new Date().toISOString(),
        })
      );
    }
    if (exceeded.length) {
      await tx.run(
        UPDATE.entity(this.__eventQueueConfig.tableNameEventQueue).where("ID IN", exceeded).with({
          status: EventProcessingStatus.Exceeded,
          lastAttemptTimestamp: new Date().toISOString(),
        })
      );
    }
    this.logger.debug("exiting persistEventStatus", {
      eventType: this.__eventType,
      eventSubType: this.__eventSubType,
    });
  }

  async deleteFinishedEvents(tx) {
    if (!this.__deleteFinishedEventsAfter) {
      return;
    }
    const deleteCount = await tx.run(
      DELETE.from(this.__eventQueueConfig.tableNameEventQueue).where(
        "type =",
        this.eventType,
        "AND subType=",
        this.eventSubType,
        "AND lastAttemptTimestamp <=",
        new Date(Date.now() - this.__deleteFinishedEventsAfter * DAYS_TO_MS).toISOString()
      )
    );
    this.logger.debug("Deleted finished events", {
      eventType: this.eventType,
      eventSubType: this.eventSubType,
      deleteFinishedEventsAfter: this.__deleteFinishedEventsAfter,
      deleteCount,
    });
  }

  #ensureEveryQueueEntryHasStatus() {
    this.__queueEntries.forEach((queueEntry) => {
      if (queueEntry.ID in this.__statusMap || queueEntry.ID in this.__commitedStatusMap) {
        return;
      }
      this.logger.error("Missing status for selected event entry. Setting status to error", {
        eventType: this.__eventType,
        eventSubType: this.__eventSubType,
        queueEntry,
      });
      this.#determineAndAddEventStatusToMap(queueEntry.ID, EventProcessingStatus.Error);
    });
  }

  #ensureEveryStatusIsAllowed(statusMap) {
    Object.entries(statusMap).forEach(([queueEntryId, status]) => {
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

      this.logger.error("Not allowed event status returned. Only Open, Done, Error is allowed!", {
        eventType: this.__eventType,
        eventSubType: this.__eventSubType,
        queueEntryId,
        status: statusMap[queueEntryId],
      });
      delete statusMap[queueEntryId];
    });
  }

  #ensureOnlySelectedQueueEntries(statusMap) {
    Object.keys(statusMap).forEach((queueEntryId) => {
      if (this.__queueEntriesMap[queueEntryId]) {
        return;
      }

      this.logger.error(
        "Status reported for event queue entry which haven't be selected before. Removing the status.",
        {
          eventType: this.__eventType,
          eventSubType: this.__eventSubType,
          queueEntryId,
        }
      );
      delete statusMap[queueEntryId];
    });
  }

  handleErrorDuringClustering(error) {
    this.logger.error(`Error during clustering of events - setting all queue entries to error. Error: ${error}`, {
      eventType: this.__eventType,
      eventSubType: this.__eventSubType,
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
        eventType: this.__eventType,
        eventSubType: this.__eventSubType,
      }
    );
    this.#determineAndAddEventStatusToMap(queueEntry.ID, EventProcessingStatus.Error);
  }

  static async handleMissingTypeImplementation(context, eventType, eventSubType) {
    const baseInstance = new EventQueueProcessorBase(context, eventType, eventSubType);
    baseInstance.logger.error("No Implementation found in the provided configuration file.", {
      eventType,
      eventSubType,
    });
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
    await executeInNewTransaction(this.__baseContext, "eventQueue-getQueueEntriesAndSetToInProgress", async (tx) => {
      const entries = await tx.run(
        SELECT.from(this.__eventQueueConfig.tableNameEventQueue)
          .forUpdate({ wait: this.__eventQueueConfig.forUpdateTimeout })
          .limit(this.getSelectMaxChunkSize())
          .where(
            "type =",
            this.__eventType,
            "AND subType=",
            this.__eventSubType,
            "AND ( status =",
            EventProcessingStatus.Open,
            "OR ( status =",
            EventProcessingStatus.Error,
            "AND lastAttemptTimestamp <=",
            this.__startTime.toISOString(),
            ") OR ( status =",
            EventProcessingStatus.InProgress,
            "AND lastAttemptTimestamp <=",
            new Date(new Date().getTime() - this.__eventQueueConfig.globalTxTimeout).toISOString(),
            ") )"
          )
          .orderBy("createdAt", "ID")
      );

      if (!entries.length) {
        this.logger.debug("no entries available for processing", {
          eventType: this.__eventType,
          eventSubType: this.__eventSubType,
        });
        this.__emptyChunkSelected = true;
        return;
      }

      const { exceededTries, openEvents, exceededTriesExceeded } = this.#filterExceededEvents(entries);
      if (exceededTries.length) {
        this.#eventsWithExceededTries = exceededTries;
      }
      if (exceededTriesExceeded.length) {
        this.#exceededTriesExceeded = exceededTriesExceeded;
      }

      result = openEvents;

      if (!result.length) {
        this.__emptyChunkSelected = true;
        return;
      }

      this.logger.info("Selected event queue entries for processing", {
        queueEntriesCount: result.length,
        eventType: this.__eventType,
        eventSubType: this.__eventSubType,
      });

      const isoTimestamp = new Date().toISOString();
      await tx.run(
        UPDATE.entity(this.__eventQueueConfig.tableNameEventQueue)
          .with({
            status: EventProcessingStatus.InProgress,
            lastAttemptTimestamp: isoTimestamp,
            attempts: { "+=": 1 },
          })
          .where(
            "ID IN",
            result
              .concat(exceededTries)
              .concat(exceededTriesExceeded)
              .map(({ ID }) => ID)
          )
      );
      result
        .concat(exceededTries)
        .concat(exceededTriesExceeded)
        .forEach((entry) => {
          entry.lastAttemptTimestamp = isoTimestamp;
          // NOTE: empty payloads are supported on DB-Level.
          // Behaviour of event queue is: null as payload is treated as obsolete/done
          // For supporting this convert null to empty string --> "" as payload will be processed normally
          if (entry.payload === null) {
            entry.payload = "";
          }
        });
    });
    this.__queueEntries = result;
    this.__queueEntriesMap = arrayToFlatMap(result);
    return result;
  }

  #filterExceededEvents(events) {
    return events.reduce(
      (result, event) => {
        if (event.attempts === this.__retryAttempts) {
          result.exceededTries.push(event);
        } else if (event.attempts === this.__retryAttempts + TRIES_FOR_EXCEEDED_EVENTS) {
          result.exceededTriesExceeded.push(event);
        } else {
          result.openEvents.push(event);
        }
        return result;
      },
      { exceededTries: [], openEvents: [], exceededTriesExceeded: [] }
    );
  }

  async handleExceededEvents() {
    await this.#handleExceededTriesExceeded();
    try {
      await this.hookForExceededEvents(this.#eventsWithExceededTries.map((a) => ({ ...a })));
      this.logger.warn("The retry attempts for the following events are exceeded", {
        eventType: this.__eventType,
        eventSubType: this.__eventSubType,
        retryAttempts: this.__retryAttempts,
        queueEntriesIds: this.#eventsWithExceededTries.map(({ ID }) => ID),
      });
      await this.#persistEventQueueStatusForExceeded(
        this.tx,
        this.#eventsWithExceededTries,
        EventProcessingStatus.Exceeded
      );
    } catch (err) {
      this.logger.error(
        `Caught error during hook for exceeded events - setting queue entry to error. Please catch your promises/exceptions. Error: ${err}`,
        {
          eventType: this.__eventType,
          eventSubType: this.__eventSubType,
          queueEntriesIds: this.#eventsWithExceededTries.map(({ ID }) => ID),
        }
      );
      await executeInNewTransaction(this.processEventContext, "error-hookForExceededEvents", async (tx) => {
        this.#persistEventQueueStatusForExceeded(tx, EventProcessingStatus.Exceeded);
      });
      throw TriggerRollback();
    }
  }

  async #handleExceededTriesExceeded() {
    if (this.#exceededTriesExceeded.length) {
      await executeInNewTransaction(this.processEventContext, "exceededTriesExceeded", async (tx) => {
        this.#persistEventQueueStatusForExceeded(tx, this.#exceededTriesExceeded, EventProcessingStatus.Error);
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
   * @param {Object} exceededEvents exceeded event queue entries
   */
  // eslint-disable-next-line no-unused-vars
  async hookForExceededEvents(exceededEvents) {}

  /**
   * This function serves the purpose of mass enabled preloading data for processing the events which are added with
   * the function 'addEventWithPayloadForProcessing'. This function is called after the clustering and before the
   * process-events-steps. The event data is available with this.eventProcessingMap.
   */
  // eslint-disable-next-line no-unused-vars
  async beforeProcessingEvents() {}

  /**
   * This function checks if the db records of events have been modified since the selection (beginning of processing)
   * If the db records are unmodified the field lastAttemptTimestamp of the records is updated to
   * "send a keep alive signal". This extends the allowed processing time of the events as events which are in progress
   * for more than 30 minutes (global tx timeout) are selected with the next tick.
   * If events are outdated/modified these events are not being processed and no status will be persisted.
   * @return {Promise<boolean>} true if the db record of the event has been modified since selection
   */
  async isOutdatedAndKeepalive(queueEntries) {
    if (!this.__outdatedCheckEnabled) {
      return false;
    }
    let eventOutdated;
    const runningChecks = queueEntries.map((queueEntry) => this.__keepalivePromises[queueEntry.ID]).filter((p) => p);
    if (runningChecks.length === queueEntries.length) {
      const results = await Promise.allSettled(runningChecks);
      for (const { value } of results) {
        if (value) {
          return true;
        }
      }
      return false;
    } else if (runningChecks.length) {
      await Promise.allSettled(runningChecks);
    }
    const checkAndUpdatePromise = new Promise((resolve) => {
      executeInNewTransaction(this.__baseContext, "eventProcessing-isOutdatedAndKeepalive", async (tx) => {
        const queueEntriesFresh = await tx.run(
          SELECT.from(this.__eventQueueConfig.tableNameEventQueue)
            .forUpdate({ wait: this.__eventQueueConfig.forUpdateTimeout })
            .where(
              "ID IN",
              queueEntries.map(({ ID }) => ID)
            )
            .columns("ID", "lastAttemptTimestamp")
        );
        eventOutdated = queueEntriesFresh.some((queueEntryFresh) => {
          const queueEntry = this.__queueEntriesMap[queueEntryFresh.ID];
          return queueEntry?.lastAttemptTimestamp !== queueEntryFresh.lastAttemptTimestamp;
        });
        let newTs = new Date().toISOString();
        if (!eventOutdated) {
          await tx.run(
            UPDATE.entity(this.__eventQueueConfig.tableNameEventQueue)
              .set("lastAttemptTimestamp =", newTs)
              .where(
                "ID IN",
                queueEntries.map(({ ID }) => ID)
              )
          );
        } else {
          newTs = null;
          this.logger.warn("event data has been modified. Processing skipped.", {
            eventType: this.__eventType,
            eventSubType: this.__eventSubType,
            queueEntriesIds: queueEntries.map(({ ID }) => ID),
          });
          queueEntries.forEach(({ ID: queueEntryId }) => delete this.__queueEntriesMap[queueEntryId]);
        }
        this.__queueEntries = Object.values(this.__queueEntriesMap);
        queueEntriesFresh.forEach((queueEntryFresh) => {
          if (this.__queueEntriesMap[queueEntryFresh.ID]) {
            const queueEntry = this.__queueEntriesMap[queueEntryFresh.ID];
            if (newTs) {
              queueEntry.lastAttemptTimestamp = newTs;
            }
          }
          delete this.__keepalivePromises[queueEntryFresh.ID];
        });
        resolve(eventOutdated);
      });
    });

    queueEntries.forEach((queueEntry) => (this.__keepalivePromises[queueEntry.ID] = checkAndUpdatePromise));
    return await checkAndUpdatePromise;
  }

  async handleDistributedLock() {
    if (this.concurrentEventProcessing) {
      return true;
    }

    const lockAcquired = await distributedLock.acquireLock(
      this.context,
      [this.eventType, this.eventSubType].join("##")
    );
    if (!lockAcquired) {
      return false;
    }
    this.__lockAcquired = true;
    return true;
  }

  async handleReleaseLock() {
    if (!this.__lockAcquired) {
      return;
    }
    try {
      await distributedLock.releaseLock(this.context, [this.eventType, this.eventSubType].join("##"));
    } catch (err) {
      this.logger.error("Releasing distributed lock failed. Error:", err.toString());
    }
  }

  statusMapContainsError(statusMap) {
    return Object.values(statusMap).includes(EventProcessingStatus.Error);
  }

  getSelectNextChunk() {
    return this.__selectNextChunk;
  }

  getSelectMaxChunkSize() {
    return this.__selectMaxChunkSize;
  }

  clearEventProcessingContext() {
    this.__processContext = null;
    this.__processTx = null;
  }

  get logger() {
    return this.__logger ?? this.__baseLogger;
  }

  get queueEntriesWithPayloadMap() {
    return this.__queueEntriesWithPayloadMap;
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
      throw EventQueueError.wrongTxUsage(this.eventType, this.eventSubType);
    }
    return this.__processTx ?? this.__tx;
  }

  get context() {
    if (!this.__txUsageAllowed && this.__parallelEventProcessing > 1) {
      throw EventQueueError.wrongTxUsage(this.eventType, this.eventSubType);
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
    return this.__eventType;
  }

  get eventSubType() {
    return this.__eventSubType;
  }

  get exceededEvents() {
    return this.#eventsWithExceededTries;
  }

  get emptyChunkSelected() {
    return this.__emptyChunkSelected;
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
}

module.exports = EventQueueProcessorBase;
