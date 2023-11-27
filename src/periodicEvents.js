"use strict";

const cds = require("@sap/cds");

const { EventProcessingStatus } = require("./constants");
const { processChunkedSync } = require("./shared/common");
const eventConfig = require("./config");

const COMPONENT_NAME = "eventQueue/periodicEvents";
const CHUNK_SIZE_INSERT_PERIODIC_EVENTS = 4;

const checkAndInsertPeriodicEvents = async (context) => {
  const tx = cds.tx(context);
  const baseCqn = SELECT.from(eventConfig.tableNameEventQueue)
    .where([
      { list: [{ ref: ["type"] }, { ref: ["subType"] }] },
      "IN",
      {
        list: eventConfig.periodicEvents.map((periodicEvent) => ({
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
    return await insertPeriodEvents(tx, eventConfig.periodicEvents);
  }

  const exitingEventMap = currentPeriodEvents.reduce((result, current) => {
    const key = _generateKey(current);
    result[key] = current;
    return result;
  }, {});

  const { newEvents, existingEvents } = eventConfig.periodicEvents.reduce(
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
    const config = eventConfig.getEventConfig(existingEvent.type, existingEvent.subType);
    const eventStartAfter = new Date(existingEvent.startAfter);
    // check if to far in future
    const dueInWithNewInterval = new Date(currentDate.getTime() + config.interval * 1000);
    return eventStartAfter >= dueInWithNewInterval;
  });

  exitingWithNotMatchingInterval.length &&
    cds.log(COMPONENT_NAME).info("deleting periodic events because they have changed", {
      changedEvents: exitingWithNotMatchingInterval.map(({ type, subType }) => ({ type, subType })),
    });

  if (exitingWithNotMatchingInterval.length) {
    await tx.run(
      DELETE.from(eventConfig.tableNameEventQueue).where(
        "ID IN",
        exitingWithNotMatchingInterval.map(({ ID }) => ID)
      )
    );
  }

  const newOrChangedEvents = newEvents.concat(exitingWithNotMatchingInterval);

  if (!newOrChangedEvents.length) {
    return;
  }

  return await insertPeriodEvents(tx, newOrChangedEvents);
};

const insertPeriodEvents = async (tx, events) => {
  const startAfter = new Date();
  let counter = 1;
  const chunks = Math.ceil(events.length / CHUNK_SIZE_INSERT_PERIODIC_EVENTS);
  const logger = cds.log(COMPONENT_NAME);
  processChunkedSync(events, CHUNK_SIZE_INSERT_PERIODIC_EVENTS, (chunk) => {
    logger.info(`${counter}/${chunks} | inserting chunk of changed or new periodic events`, {
      events: chunk.map(({ type, subType }) => {
        const { interval } = eventConfig.getEventConfig(type, subType);
        return { type, subType, interval };
      }),
    });
    counter++;
  });
  const periodEventsInsert = events.map((periodicEvent) => ({
    type: periodicEvent.type,
    subType: periodicEvent.subType,
    startAfter: startAfter,
  }));

  tx._skipEventQueueBroadcase = true;
  await tx.run(INSERT.into(eventConfig.tableNameEventQueue).entries(periodEventsInsert));
  tx._skipEventQueueBroadcase = false;
};

const _generateKey = ({ type, subType }) => [type, subType].join("##");

module.exports = {
  checkAndInsertPeriodicEvents,
};
