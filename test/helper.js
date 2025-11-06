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

module.exports = {
  selectEventQueueAndExpectDone,
  selectEventQueueAndExpectOpen,
  selectEventQueueAndExpectError,
  selectEventQueueAndExpectExceeded,
  selectEventQueueAndReturn,
  insertEventEntry,
  getEventEntry,
};
