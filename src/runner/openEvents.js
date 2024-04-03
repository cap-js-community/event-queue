"use strict";

const cds = require("@sap/cds");

const eventConfig = require("../config");
const { EventProcessingStatus } = require("../constants");

const getOpenQueueEntries = async (tx) => {
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
    if (type.startsWith("CAP_OUTBOX")) {
      if (cds.requires[subType]) {
        await cds.connect.to(subType).catch(() => {});
        result.push({ type, subType });
      } else {
        const service = await cds.connect.to(subType).catch(() => {});
        if (service) {
          result.push({ type, subType });
        }
      }
    } else {
      if (eventConfig.getEventConfig(type, subType)) {
        result.push({ type, subType });
      }
    }
  }
  return result;
};

module.exports = {
  getOpenQueueEntries,
};
