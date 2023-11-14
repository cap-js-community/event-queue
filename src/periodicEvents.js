"use strict";

const cds = require("@sap/cds");

const { publishEvent } = require("./publishEvent");
const { EventProcessingStatus } = require("./constants");
const { processChunkedSync } = require("./shared/common");
const { getConfigInstance } = require("./config");

const COMPONENT_NAME = "eventQueue/periodicEvents";

const checkAndInsertPeriodicEvents = async (context) => {
  const tx = cds.tx(context);
  const configInstance = getConfigInstance();
  const baseCqn = SELECT.from(configInstance.tableNameEventQueue)
    .where([
      { list: [{ ref: ["type"] }, { ref: ["subType"] }] },
      "IN",
      {
        list: configInstance.periodicEvents.map((periodicEvent) => ({
          list: [{ val: periodicEvent.type }, { val: periodicEvent.subType }],
        })),
      },
      "AND",
      { ref: ["status"] },
      "=",
      { val: EventProcessingStatus.Open },
    ])
    .columns(["ID", "type", "subType", "startAfter"]);
  const currentPeriodEvents = await tx.run(baseCqn);

  if (!currentPeriodEvents.length) {
    // fresh insert all
    return await insertPeriodEvents(tx, configInstance.periodicEvents);
  }

  const exitingEventMap = currentPeriodEvents.reduce((result, current) => {
    const key = _generateKey(current);
    result[key] = current;
    return result;
  }, {});

  const { newEvents, existingEvents } = configInstance.periodicEvents.reduce(
    (result, event) => {
      if (exitingEventMap[_generateKey(event)]) {
        result.existingEvents.push(exitingEventMap[_generateKey(event)]);
      } else {
        result.newEvents.push(event);
      }
      return result;
    },
    { newEvents: [], existingEvents: [] }
  );

  const currentDate = new Date();
  const exitingWithNotMatchingInterval = existingEvents.filter((existingEvent) => {
    const config = configInstance.getEventConfig(existingEvent.type, existingEvent.subType);
    const eventStartAfter = new Date(existingEvent.startAfter);
    // check if to far in future
    const dueInWithNewInterval = new Date(currentDate.getTime() + config.interval * 1000);
    return eventStartAfter >= dueInWithNewInterval;
  });

  exitingWithNotMatchingInterval.length &&
    cds.log(COMPONENT_NAME).info("deleting periodic events because they have changed", {
      changedEvents: exitingWithNotMatchingInterval.map(({ type, subType }) => ({ type, subType })),
    });
  await tx.run(
    DELETE.from(configInstance.tableNameEventQueue).where(
      "ID IN",
      exitingWithNotMatchingInterval.map(({ ID }) => ID)
    )
  );

  const newOrChangedEvents = newEvents.concat(exitingWithNotMatchingInterval);

  if (!newOrChangedEvents.length) {
    return;
  }

  return await insertPeriodEvents(tx, newOrChangedEvents);
};

const insertPeriodEvents = async (tx, events) => {
  const startAfter = new Date();
  const configInstance = getConfigInstance();
  processChunkedSync(events, 4, (chunk) => {
    cds.log(COMPONENT_NAME).info("inserting changed or new periodic events", {
      events: chunk.map(({ type, subType }) => {
        const { interval } = configInstance.getEventConfig(type, subType);
        return { type, subType, interval };
      }),
    });
  });
  const periodEventsInsert = events.map((periodicEvent) => ({
    type: periodicEvent.type,
    subType: periodicEvent.subType,
    startAfter: startAfter,
  }));
  await publishEvent(tx, periodEventsInsert, true);
};

const _generateKey = ({ type, subType }) => [type, subType].join("##");

module.exports = {
  checkAndInsertPeriodicEvents,
};
