"use strict";

const { EventProcessingStatus } = require("../src/constants");
const eventQueue = require("../src");

const _selectEventQueueAndExpect = async (tx, status, expectedLength = 1) => {
  const events = await tx.run(SELECT.from("sap.eventqueue.Event"));
  expect(events).toHaveLength(expectedLength);
  for (const event of events) {
    expect(event.status).toEqual(status);
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
  { entries, numberOfEntries = 1, type = "Notifications", subType = "Task", randomGuid = false } = {}
) => {
  if (!entries || entries?.length === 0) {
    entries = [
      {
        ...getEventEntry(),
        ...(randomGuid ? {} : { ID: "dbaa22d5-41db-4ff3-bdd8-e0bb19b217cf" }),
        type,
        subType,
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
        });
      });
  }
  await tx.run(INSERT.into("sap.eventqueue.Event").entries(entries));
};

const selectEventQueueAndExpectDone = async (tx, expectedLength = 1) =>
  _selectEventQueueAndExpect(tx, EventProcessingStatus.Done, expectedLength);

const selectEventQueueAndExpectOpen = async (tx, expectedLength = 1) =>
  _selectEventQueueAndExpect(tx, EventProcessingStatus.Open, expectedLength);

const selectEventQueueAndExpectError = async (tx, expectedLength = 1) =>
  _selectEventQueueAndExpect(tx, EventProcessingStatus.Error, expectedLength);

const selectEventQueueAndExpectExceeded = async (tx, expectedLength = 1) =>
  _selectEventQueueAndExpect(tx, EventProcessingStatus.Exceeded, expectedLength);

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
