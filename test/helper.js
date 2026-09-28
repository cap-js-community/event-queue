"use strict";

const { EventProcessingStatus } = require("../src/constants");
const eventQueue = require("../src");

const _selectEventQueueAndExpect = async (tx, status, { expectedLength = 1, attempts, type, subType } = {}) => {
  const baseCqn = SELECT.from("sap.eventqueue.Event");
  type && baseCqn.where({ type });
  subType && baseCqn.where({ subType });
  const events = await tx.run(baseCqn);
  expect(events).toHaveLength(expectedLength);
  for (const event of events) {
    expect(event.status).toEqual(status);
    attempts && expect(event.attempts).toEqual(attempts);
  }
};

const getEventEntry = () => {
  const event = eventQueue.config.events[0];
  return {
    type: event.type,
    subType: event.subType,
    payload: JSON.stringify({
      testPayload: 123,
    }),
    namespace: "default",
  };
};

const insertEventEntry = async (
  tx,
  {
    entries,
    numberOfEntries = 1,
    type = "Notifications",
    subType = "Task",
    randomGuid = false,
    delayedSeconds = null,
    status = EventProcessingStatus.Open,
  } = {}
) => {
  if (!entries || entries?.length === 0) {
    const startAfter = delayedSeconds ? new Date(Date.now() + delayedSeconds * 1000) : null;
    entries = [
      {
        ...getEventEntry(),
        ...(randomGuid ? {} : { ID: "dbaa22d5-41db-4ff3-bdd8-e0bb19b217cf" }),
        type,
        subType,
        startAfter,
        status,
        namespace: eventQueue.config.namespace,
      },
    ];
    Array(numberOfEntries - 1)
      .fill({})
      .forEach(() => {
        entries.push({
          type,
          subType,
          payload: JSON.stringify({
            testPayload: 123,
          }),
          startAfter,
          status,
          namespace: eventQueue.config.namespace,
        });
      });
  }
  await tx.run(INSERT.into("sap.eventqueue.Event").entries(entries));
};

const selectEventQueueAndExpectDone = async (tx, { expectedLength = 1, attempts, type, subType } = {}) =>
  _selectEventQueueAndExpect(tx, EventProcessingStatus.Done, { expectedLength, attempts, type, subType });

const selectEventQueueAndExpectOpen = async (tx, { expectedLength = 1, attempts, type, subType } = {}) =>
  _selectEventQueueAndExpect(tx, EventProcessingStatus.Open, { expectedLength, attempts, type, subType });

const selectEventQueueAndExpectError = async (tx, { expectedLength = 1, attempts, type, subType } = {}) =>
  _selectEventQueueAndExpect(tx, EventProcessingStatus.Error, { expectedLength, attempts, type, subType });

const selectEventQueueAndExpectExceeded = async (tx, { expectedLength = 1, attempts, type, subType } = {}) =>
  _selectEventQueueAndExpect(tx, EventProcessingStatus.Exceeded, { expectedLength, attempts, type, subType });

const selectEventQueueAndReturn = async (
  tx,
  { expectedLength = 1, type, subType, additionalColumns = [], parseColumns = false } = {}
) => {
  const baseCqn = SELECT.from("sap.eventqueue.Event").orderBy("lastAttemptTimestamp");
  if (additionalColumns !== "*") {
    baseCqn.columns("status", "attempts", "startAfter", ...additionalColumns);
  }
  type && baseCqn.where({ type });
  subType && baseCqn.where({ subType });
  const events = await tx.run(baseCqn);
  expect(events).toHaveLength(expectedLength);
  if (parseColumns) {
    for (const event of events) {
      event.payload = JSON.parse(event.payload);
      event.context = JSON.parse(event.context);
    }
  }
  return events;
};

const holdPersistSpies = [];

// processEvent runs one after another, persistEventStatus waits until the first `count` calls arrived
const holdPersistUntilAllProcessed = (
  count,
  { failForId, failAfterPersist = false, failForStatuses = [EventProcessingStatus.Done] } = {}
) => {
  const EventQueueGenericOutboxHandler = require("../src/outbox/EventQueueGenericOutboxHandler");
  const EventQueueProcessorBase = require("../src/EventQueueProcessorBase");

  const originalProcessEvent = EventQueueGenericOutboxHandler.prototype.processEvent;
  let processQueue = Promise.resolve();
  const processEventSpy = jest
    .spyOn(EventQueueGenericOutboxHandler.prototype, "processEvent")
    .mockImplementation(function (...args) {
      const result = processQueue.then(() => originalProcessEvent.apply(this, args));
      processQueue = result.catch(() => {});
      return result;
    });

  const originalPersist = EventQueueProcessorBase.prototype.persistEventStatus;
  let arrived = 0;
  let release;
  // NOTE: released after 30s so a missing call fails the test instead of blocking it
  const barrier = new Promise((resolve) => {
    release = resolve;
    setTimeout(resolve, 30 * 1000).unref();
  });
  const persistSpy = jest
    .spyOn(EventQueueProcessorBase.prototype, "persistEventStatus")
    .mockImplementation(async function (tx, options) {
      if (arrived < count) {
        arrived++;
        arrived === count && release();
        await barrier;
      }
      const shouldFail = failForId && failForStatuses.includes(options?.statusMap?.[failForId]?.status);
      if (shouldFail && !failAfterPersist) {
        throw new Error("persist failed");
      }
      const result = await originalPersist.call(this, tx, options);
      if (shouldFail) {
        throw new Error("persist failed");
      }
      return result;
    });
  holdPersistSpies.push(processEventSpy, persistSpy);
};

// NOTE: restores only these spies, jest.restoreAllMocks would also restore the logger mock
const restoreHoldPersist = () => {
  holdPersistSpies.splice(0).forEach((spy) => spy.mockRestore());
};

// resolves the returned function for all callers once `count` callers are waiting
const createBarrier = (count) => {
  let arrived = 0;
  let release;
  // NOTE: released after 30s so a missing caller fails the test instead of blocking it
  const barrier = new Promise((resolve) => {
    release = resolve;
    setTimeout(resolve, 30 * 1000).unref();
  });
  return async () => {
    arrived++;
    arrived === count && release();
    await barrier;
  };
};

module.exports = {
  createBarrier,
  holdPersistUntilAllProcessed,
  restoreHoldPersist,
  selectEventQueueAndExpectDone,
  selectEventQueueAndExpectOpen,
  selectEventQueueAndExpectError,
  selectEventQueueAndExpectExceeded,
  selectEventQueueAndReturn,
  insertEventEntry,
  getEventEntry,
};
