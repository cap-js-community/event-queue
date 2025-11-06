"use strict";

const cds = require("@sap/cds");

const eventConfig = require("../config");
const { EventProcessingStatus } = require("../constants");
const config = require("../config");

const MS_IN_DAYS = 24 * 60 * 60 * 1000;

const getOpenQueueEntries = async (tx, filterAppSpecificEvents = true) => {
  const startTime = new Date();
  const refDateStartAfter = new Date(startTime.getTime() + eventConfig.runInterval * 1.2);
  const entries = await tx.run(
    SELECT.from(eventConfig.tableNameEventQueue)
      .where(
        "namespace IN",
        config.processingNamespaces,
        "AND ( startAfter IS NULL OR startAfter <=",
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
      .columns("type", "subType", "namespace")
      .groupBy("type", "subType", "namespace")
  );

  const result = [];
  for (const { type, subType, namespace } of entries) {
    if (eventConfig.isCapOutboxEvent(type)) {
      const [srvName, actionName] = subType.split(".");
      try {
        const service = await cds.connect.to(srvName);
        if (filterAppSpecificEvents) {
          if (!service) {
            continue;
          }
          cds.outboxed(service);
          if (actionName) {
            config.addCAPOutboxEventSpecificAction(srvName, actionName);
          }
          if (eventConfig.shouldBeProcessedInThisApplication(type, subType, namespace)) {
            result.push({ namespace, type, subType });
          }
        }
      } catch {
        /* ignore catch */
      } finally {
        if (!filterAppSpecificEvents) {
          result.push({ namespace, type, subType });
        }
      }
    } else {
      if (filterAppSpecificEvents) {
        if (
          eventConfig.getEventConfig(type, subType, namespace) &&
          eventConfig.shouldBeProcessedInThisApplication(type, subType, namespace)
        ) {
          result.push({ namespace, type, subType });
        }
      } else {
        result.push({ namespace, type, subType });
      }
    }
  }
  return result;
};

module.exports = {
  getOpenQueueEntries,
};
