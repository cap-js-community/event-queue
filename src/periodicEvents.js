"use strict";

const cds = require("@sap/cds");

const { EventProcessingStatus } = require("./constants");
const { processChunkedSync } = require("./shared/common");
const eventConfig = require("./config");

const COMPONENT_NAME = "/eventQueue/periodicEvents";
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
      "IN",
      {
        list: [{ val: EventProcessingStatus.Open }, { val: EventProcessingStatus.InProgress }],
      },
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

const calculateFutureDate = (intervalInSeconds, desiredTime, isUTC = true) => {
  const [hours, minutes] = desiredTime.split(":").map(Number);
  const now = new Date();

  const year = isUTC ? now.getUTCFullYear() : now.getFullYear();
  const month = isUTC ? now.getUTCMonth() : now.getMonth();
  const day = isUTC ? now.getUTCDate() : now.getDate();
  const hour = isUTC ? now.getUTCHours() : now.getHours();
  const minute = isUTC ? now.getUTCMinutes() : now.getMinutes();
  const seconds = isUTC ? now.getUTCSeconds() : now.getSeconds();

  let dateWithTime = isUTC
    ? new Date(Date.UTC(year, month, day, hours, minutes, 0, 0))
    : new Date(year, month, day, hours, minutes, 0, 0);
  let timeDifferenceInSeconds = Math.round((now - dateWithTime) / 1000);
  if (timeDifferenceInSeconds % intervalInSeconds === 0) {
    return isUTC
      ? new Date(Date.UTC(year, month, day, hour, minute, seconds))
      : new Date(year, month, day, hour, minute, seconds);
  }

  if (timeDifferenceInSeconds < 0) {
    // If the desired time is in the future, move to the previous occurrence of the event.
    timeDifferenceInSeconds = -Math.abs(timeDifferenceInSeconds);
  }

  const additionalIntervals = Math.floor(timeDifferenceInSeconds / intervalInSeconds);
  dateWithTime = new Date(dateWithTime.getTime() + additionalIntervals * intervalInSeconds * 1000);
  if (isUTC) {
    dateWithTime = new Date(
      Date.UTC(
        dateWithTime.getUTCFullYear(),
        dateWithTime.getUTCMonth(),
        dateWithTime.getUTCDate(),
        dateWithTime.getUTCHours(),
        dateWithTime.getUTCMinutes(),
        dateWithTime.getUTCSeconds()
      )
    );
  }
  return dateWithTime;
};

const insertPeriodEvents = async (tx, events) => {
  const startAfter = new Date();
  let counter = 1;
  const chunks = Math.ceil(events.length / CHUNK_SIZE_INSERT_PERIODIC_EVENTS);
  const logger = cds.log(COMPONENT_NAME);
  const eventsToBeInserted = events.map((event) => {
    const base = { type: event.type, subType: event.subType };
    let startTime = startAfter;
    if (event.startTimeUTC) {
      startTime = calculateFutureDate(event.interval, event.startTimeUTC, true);
    } else if (event.startTimeLocal) {
      startTime = calculateFutureDate(event.interval, event.startTimeLocal);
    }
    base.startAfter = startTime.toISOString();
    return base;
  }, []);

  processChunkedSync(eventsToBeInserted, CHUNK_SIZE_INSERT_PERIODIC_EVENTS, (chunk) => {
    logger.info(`${counter}/${chunks} | inserting chunk of changed or new periodic events`, {
      events: chunk.map(({ type, subType, startAfter }) => {
        const { interval } = eventConfig.getEventConfig(type, subType);
        return { type, subType, interval, ...(startAfter && { startAfter }) };
      }),
    });
    counter++;
  });

  tx._skipEventQueueBroadcase = true;
  await tx.run(INSERT.into(eventConfig.tableNameEventQueue).entries(eventsToBeInserted));
  tx._skipEventQueueBroadcase = false;
};

const _generateKey = ({ type, subType }) => [type, subType].join("##");

module.exports = {
  checkAndInsertPeriodicEvents,
  calculateFutureDate,
};
