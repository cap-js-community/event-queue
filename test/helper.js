"use strict";

const { EventProcessingStatus } = require("../src/constants");
const eventQueue = require("../src");

const _selectEventQueueAndExpect = async (tx, status, expectedLength = 1) => {
  const events = await tx.run(SELECT.from("sap.core.EventQueue"));
  expect(events).toHaveLength(expectedLength);
  for (const event of events) {
    expect(event.status).toEqual(status);
  }
};

const insertEventEntry = async (tx, entires) => {
  if (!entires || entires?.length === 0) {
    const event = eventQueue.getConfigInstance().events[0];
    entires = [
      {
        ID: "dbaa22d5-41db-4ff3-bdd8-e0bb19b217cf",
        type: event.type,
        subType: event.subType,
        payload: JSON.stringify({
          testPayload: 123,
        }),
      },
    ];
  }
  await tx.run(INSERT.into("sap.core.EventQueue").entries(entires));
};

const selectEventQueueAndExpectDone = async (tx, expectedLength = 1) =>
  _selectEventQueueAndExpect(tx, EventProcessingStatus.Done, expectedLength);

const selectEventQueueAndExpectOpen = async (tx, expectedLength = 1) =>
  _selectEventQueueAndExpect(tx, EventProcessingStatus.Open, expectedLength);

const selectEventQueueAndExpectError = async (tx, expectedLength = 1) =>
  _selectEventQueueAndExpect(tx, EventProcessingStatus.Error, expectedLength);

module.exports = {
  selectEventQueueAndExpectDone,
  selectEventQueueAndExpectOpen,
  selectEventQueueAndExpectError,
  insertEventEntry,
};
