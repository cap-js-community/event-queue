"use strict";

const cds = require("@sap/cds");

const eventConfig = require("../config");
const { EventProcessingStatus } = require("../constants");

const MS_IN_DAYS = 24 * 60 * 60 * 1000;

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
        ") ) AND (createdAt >=",
        new Date(startTime.getTime() - 30 * MS_IN_DAYS).toISOString(),
        " OR startAfter >=",
        new Date(startTime.getTime() - 30 * MS_IN_DAYS).toISOString(),
        ")"
      )
      .columns("type", "subType")
      .groupBy("type", "subType")
  );

  const result = [];
  for (const { type, subType } of entries) {
    if (eventConfig.isCapOutboxEvent(type)) {
      cds.connect
        .to(subType)
        .then((service) => {
          if (!filterAppSpecificEvents) {
            return; // will be done in finally
          }

          if (!service) {
            return;
          }
          cds.outboxed(service);
          if (filterAppSpecificEvents) {
            if (eventConfig.shouldBeProcessedInThisApplication(type, subType)) {
              result.push({ type, subType });
            }
          } else {
            result.push({ type, subType });
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!filterAppSpecificEvents) {
            result.push({ type, subType });
          }
        });
    } else {
      if (filterAppSpecificEvents) {
        if (
          eventConfig.getEventConfig(type, subType) &&
          eventConfig.shouldBeProcessedInThisApplication(type, subType)
        ) {
          result.push({ type, subType });
        }
      } else {
        result.push({ type, subType });
      }
    }
  }
  return result;
};

module.exports = {
  getOpenQueueEntries,
};
