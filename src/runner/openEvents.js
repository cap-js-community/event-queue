"use strict";

const cds = require("@sap/cds");

const eventConfig = require("../config");
const { EventProcessingStatus } = require("../constants");

const getOpenQueueEntries = async (tx, filterAppSpecificEvents = true) => {
  const startTime = new Date();
  const refDateStartAfter = new Date(startTime.getTime() + eventConfig.runInterval * 1.2);
  const entries = await tx.run(
    SELECT.from(eventConfig.tableNameEventQueue)
      .where(
        "( startAfter IS NULL OR startAfter <=",
        refDateStartAfter.toISOString(),
        " ) AND ( status =",
        EventProcessingStatus.Open,
        "OR ( status =",
        EventProcessingStatus.Error,
        ") OR ( status =",
        EventProcessingStatus.InProgress,
        "AND lastAttemptTimestamp <=",
        new Date(startTime.getTime() - eventConfig.globalTxTimeout).toISOString(),
        ") )"
      )
      .columns("type", "subType")
      .groupBy("type", "subType")
  );

  const result = [];
  for (const { type, subType } of entries) {
    if (eventConfig.isCapOutboxEvent(type)) {
      await cds.connect
        .to(subType)
        .then((service) => {
          if (!service) {
            return;
          }
          cds.outboxed(service);
          if (filterAppSpecificEvents && eventConfig.shouldBeProcessedInThisApplication(type, subType)) {
            result.push({ type, subType });
          }
        })
        .catch(() => {});
    } else {
      if (
        eventConfig.getEventConfig(type, subType) &&
        filterAppSpecificEvents &&
        eventConfig.shouldBeProcessedInThisApplication(type, subType)
      ) {
        result.push({ type, subType });
      }
    }
  }
  return result;
};

module.exports = {
  getOpenQueueEntries,
};
