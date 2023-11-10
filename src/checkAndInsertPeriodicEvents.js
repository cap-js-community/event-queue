"use strict";

const cds = require("@sap/cds");

const eventQueueConfig = require("./config");
const eventScheduler = require("./shared/EventScheduler");
const { publishEvent } = require("./publishEvent");

const checkAndInsertPeriodicEvents = async (context) => {
  const tx = cds.tx(context);
  const configInstance = eventQueueConfig.getConfigInstance();
  const baseCqn = SELECT.from(configInstance.tableNameEventQueue).where([
    { list: [{ ref: ["type"] }, { ref: ["subType"] }] },
    "IN",
    {
      list: configInstance.periodicEvents.map((periodicEvent) => ({
        list: [{ val: periodicEvent.type }, { val: periodicEvent.subType }],
      })),
    },
  ]);
  const currentPeriodEvents = await tx.run(baseCqn);

  if (!currentPeriodEvents.length) {
    await insertAllEvents(tx);
  }
};

const insertAllEvents = async (tx) => {
  const configInstance = eventQueueConfig.getConfigInstance();
  const offset = configInstance.periodicEventOffset;
  const baseDate = eventScheduler.getInstance().calculateFutureTime(new Date(), offset);
  const periodicEvents = configInstance.periodicEvents;
  const periodEventsInsert = periodicEvents.map((periodicEvent) => ({
    type: periodicEvent.type,
    subType: periodicEvent.subType,
    startAfter: baseDate,
  }));
  await publishEvent(tx, periodEventsInsert);
};

module.exports = {
  checkAndInsertPeriodicEvents,
};
