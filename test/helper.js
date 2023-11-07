"use strict";

const { EventProcessingStatus } = require("../src/constants");
const eventQueue = require("../src");

const _selectEventQueueAndExpect = async (tx, status, expectedLength = 1, attempts) => {
  const events = await tx.run(SELECT.from("sap.eventqueue.Event"));
  expect(events).toHaveLength(expectedLength);
  for (const event of events) {
    expect(event.status).toEqual(status);
    attempts && expect(event.attempts).toEqual(attempts);
  }
};

const getEventEntry = () => {
  const event = eventQueue.getConfigInstance().events[0];
  return {
    type: event.type,
    subType: event.subType,
    payload: JSON.stringify({
      testPayload: 123,
    }),
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
        });
      });
  }
  await tx.run(INSERT.into("sap.eventqueue.Event").entries(entries));
};

const selectEventQueueAndExpectDone = async (tx, expectedLength = 1, attempts) =>
  _selectEventQueueAndExpect(tx, EventProcessingStatus.Done, expectedLength, attempts);

const selectEventQueueAndExpectOpen = async (tx, expectedLength = 1, attempts) =>
  _selectEventQueueAndExpect(tx, EventProcessingStatus.Open, expectedLength, attempts);

const selectEventQueueAndExpectError = async (tx, expectedLength = 1, attempts) =>
  _selectEventQueueAndExpect(tx, EventProcessingStatus.Error, expectedLength, attempts);

const selectEventQueueAndExpectExceeded = async (tx, expectedLength = 1, attempts) =>
  _selectEventQueueAndExpect(tx, EventProcessingStatus.Exceeded, expectedLength, attempts);

const selectEventQueueAndReturn = async (tx, expectedLength = 1) => {
  const events = await tx.run(SELECT.from("sap.eventqueue.Event").columns("status", "attempts"));
  expect(events).toHaveLength(expectedLength);
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
