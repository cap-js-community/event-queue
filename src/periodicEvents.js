"use strict";

const cds = require("@sap/cds");
const cronParser = require("cron-parser");

const { EventProcessingStatus } = require("./constants");
const { processChunkedSync } = require("./shared/common");
const eventConfig = require("./config");

const COMPONENT_NAME = "/eventQueue/periodicEvents";
const CHUNK_SIZE_INSERT_PERIODIC_EVENTS = 4;

const checkAndInsertPeriodicEvents = async (context) => {
  const now = new Date();
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
    .groupBy("type", "subType", "createdAt")
    .columns(["type", "subType", "createdAt", "max(startAfter) as startAfter"]);
  const currentPeriodEvents = await tx.run(baseCqn);
  currentPeriodEvents.length &&
    (await tx.run(_addWhere(SELECT.from(eventConfig.tableNameEventQueue).columns("ID"), currentPeriodEvents)));

  if (!currentPeriodEvents.length) {
    // fresh insert all
    return await _insertPeriodEvents(tx, eventConfig.periodicEvents, now);
  }

  const exitingEventMap = currentPeriodEvents.reduce((result, current) => {
    const key = _generateKey(current);
    result[key] = current;
    return result;
  }, {});

  const { newEvents, existingEventsCron, existingEventsInterval } = eventConfig.periodicEvents.reduce(
    (result, event) => {
      const existingEvent = exitingEventMap[_generateKey(event)];
      if (existingEvent) {
        const config = eventConfig.getEventConfig(existingEvent.type, existingEvent.subType);
        if (config.cron) {
          result.existingEventsCron.push(exitingEventMap[_generateKey(event)]);
        } else {
          result.existingEventsInterval.push(exitingEventMap[_generateKey(event)]);
        }
      } else {
        result.newEvents.push(event);
      }
      return result;
    },
    { newEvents: [], existingEventsCron: [], existingEventsInterval: [] }
  );

  const exitingWithNotMatchingInterval = []
    .concat(_determineChangedInterval(existingEventsInterval, now))
    .concat(_determineChangedCron(existingEventsCron, now));

  exitingWithNotMatchingInterval.length &&
    cds.log(COMPONENT_NAME).info("deleting periodic events because they have changed", {
      changedEvents: exitingWithNotMatchingInterval.map(({ type, subType }) => ({ type, subType })),
    });

  if (exitingWithNotMatchingInterval.length) {
    const cqnBase = DELETE.from(eventConfig.tableNameEventQueue);
    _addWhere(cqnBase, exitingWithNotMatchingInterval);
    const deleteCount = await tx.run(cqnBase);
    if (deleteCount !== exitingWithNotMatchingInterval.length) {
      cds.log(COMPONENT_NAME).warn("deletion count doesn't match expected count", {
        deleteCount,
      });
    }
  }

  const newOrChangedEvents = newEvents.concat(exitingWithNotMatchingInterval);

  if (!newOrChangedEvents.length) {
    return;
  }

  return await _insertPeriodEvents(tx, newOrChangedEvents, now);
};

const _addWhere = (cqnBase, events) => {
  let or = false;
  for (const { type, subType, createdAt, startAfter } of events) {
    cqnBase[or ? "or" : "where"]({ type, subType, createdAt, startAfter });
    or = true;
  }
  return cqnBase;
};

const _determineChangedInterval = (existingEvents, currentDate) => {
  return existingEvents.filter((existingEvent) => {
    const config = eventConfig.getEventConfig(existingEvent.type, existingEvent.subType);
    const eventStartAfter = new Date(existingEvent.startAfter);
    // check if too far in future
    const dueInWithNewInterval = new Date(currentDate.getTime() + config.interval * 1000);
    return eventStartAfter >= dueInWithNewInterval;
  });
};

const _determineChangedCron = (existingEventsCron) => {
  return existingEventsCron.filter((event) => {
    const config = eventConfig.getEventConfig(event.type, event.subType);
    const eventStartAfter = new Date(event.startAfter);
    const eventCreatedAt = new Date(event.createdAt);
    const cronExpression = cronParser.parseExpression(config.cron, {
      currentDate: eventCreatedAt,
      utc: config.utc,
      ...(config.useCronTimezone && { tz: eventConfig.cronTimezone }),
    });
    return cronExpression.next().getTime() - eventStartAfter.getTime() > 30 * 1000; // report as changed if diff created than 30 seconds
  });
};

const _insertPeriodEvents = async (tx, events, now) => {
  let counter = 1;
  const chunks = Math.ceil(events.length / CHUNK_SIZE_INSERT_PERIODIC_EVENTS);
  const logger = cds.log(COMPONENT_NAME);
  const eventsToBeInserted = events.map((event) => {
    const base = { type: event.type, subType: event.subType };
    let startTime = now;
    if (event.cron) {
      startTime = cronParser
        .parseExpression(event.cron, {
          currentDate: now,
          utc: event.utc,
          ...(event.useCronTimezone && { tz: eventConfig.cronTimezone }),
        })
        .next();
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
};
