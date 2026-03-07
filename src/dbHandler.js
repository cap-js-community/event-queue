"use strict";

const cds = require("@sap/cds");

const redisPub = require("./redis/redisPub");
const config = require("./config");
const eventQueueStats = require("./shared/eventQueueStats");
const { EventProcessingStatus } = require("./constants");

const COMPONENT_NAME = "/eventQueue/dbHandler";
const registeredHandlers = {
  eventQueueDbHandler: false,
  beforeDbHandler: false,
  updateDbHandler: false,
};

const registerEventQueueDbHandler = (dbService) => {
  if (registeredHandlers.eventQueueDbHandler) {
    return;
  }

  registeredHandlers.eventQueueDbHandler = true;
  const def = dbService.model.definitions[config.tableNameEventQueue];
  dbService.after("CREATE", def, (_, req) => {
    if (req.tx._skipEventQueueBroadcast) {
      return;
    }
    req.tx._ = req.tx._ ?? {};
    req.tx._.eventQueuePublishEvents = req.tx._.eventQueuePublishEvents ?? {};
    const eventQueuePublishEvents = req.tx._.eventQueuePublishEvents;
    const data = Array.isArray(req.query.INSERT.entries) ? req.query.INSERT.entries : [req.query.INSERT.entries];

    req.tx._.eventQueueStatsOpenCount = (req.tx._.eventQueueStatsOpenCount ?? 0) + data.length;
    const newCombinations = data.reduce((result, event) => {
      const key = [event.type, event.subType, event.namespace].join("##");
      if (config.hasEventAfterCommitFlag(event.type, event.subType, event.namespace) && !eventQueuePublishEvents[key]) {
        eventQueuePublishEvents[key] = true;
        result.push(key);
      }
      return result;
    }, []);

    req.tx._.eventQueueBroadcastCombinations ??= [];
    req.tx._.eventQueueBroadcastCombinations.push(...newCombinations);
    if (!req.tx._.eventQueueSucceededHandlerRegistered) {
      req.tx._.eventQueueSucceededHandlerRegistered = true;
      req.on("succeeded", () => {
        if (config.redisEnabled && req.tx._.eventQueueStatsOpenCount) {
          eventQueueStats
            .incrementCounters(req.tenant, eventQueueStats.StatusField.Pending, req.tx._.eventQueueStatsOpenCount)
            .catch((err) => {
              cds.log(COMPONENT_NAME).error("db handler failure during updating event stats", err, {
                tenant: req.tenant,
              });
            });
        }
        const combinations = req.tx._.eventQueueBroadcastCombinations;
        if (combinations.length) {
          const events = combinations.map((combination) => {
            const [type, subType, namespace] = combination.split("##");
            return { type, subType, namespace };
          });
          redisPub.broadcastEvent(req.tenant, events).catch((err) => {
            cds.log(COMPONENT_NAME).error("db handler failure during broadcasting event", err, {
              tenant: req.tenant,
              events,
            });
          });
        }
      });
    }
  });

  if (!registeredHandlers.updateDbHandler) {
    registeredHandlers.updateDbHandler = true;
    dbService.after("UPDATE", def, (affectedRows, req) => {
      const newStatus = req.query.UPDATE?.data?.status;
      if (newStatus == null) {
        return;
      }

      const count = typeof affectedRows === "number" && affectedRows > 0 ? affectedRows : 1;

      req.tx._ = req.tx._ ?? {};
      req.tx._.eventQueueStatsPendingDelta = req.tx._.eventQueueStatsPendingDelta ?? 0;
      req.tx._.eventQueueStatsInProgressDelta = req.tx._.eventQueueStatsInProgressDelta ?? 0;

      if (newStatus === EventProcessingStatus.InProgress) {
        req.tx._.eventQueueStatsPendingDelta -= count;
        req.tx._.eventQueueStatsInProgressDelta += count;
      } else if (newStatus === EventProcessingStatus.Error) {
        req.tx._.eventQueueStatsInProgressDelta -= count;
        req.tx._.eventQueueStatsPendingDelta += count;
      } else if (
        newStatus === EventProcessingStatus.Done ||
        newStatus === EventProcessingStatus.Exceeded ||
        newStatus === EventProcessingStatus.Suspended
      ) {
        req.tx._.eventQueueStatsInProgressDelta -= count;
      }

      if (!req.tx._.eventQueueUpdateSucceededHandlerRegistered) {
        req.tx._.eventQueueUpdateSucceededHandlerRegistered = true;
        req.on("succeeded", () => {
          if (!config.redisEnabled) {
            return;
          }

          const pendingDelta = req.tx._.eventQueueStatsPendingDelta;
          const inProgressDelta = req.tx._.eventQueueStatsInProgressDelta;
          const ops = [];

          if (pendingDelta !== 0) {
            ops.push(
              eventQueueStats.adjustTenantCounter(req.tenant, eventQueueStats.StatusField.Pending, pendingDelta),
              eventQueueStats.adjustGlobalCounter(eventQueueStats.StatusField.Pending, pendingDelta)
            );
          }
          if (inProgressDelta !== 0) {
            ops.push(
              eventQueueStats.adjustTenantCounter(req.tenant, eventQueueStats.StatusField.InProgress, inProgressDelta),
              eventQueueStats.adjustGlobalCounter(eventQueueStats.StatusField.InProgress, inProgressDelta)
            );
          }
          Promise.allSettled(ops).then((results) => {
            for (const result of results) {
              if (result.status === "rejected") {
                cds
                  .log(COMPONENT_NAME)
                  .error("db handler failure during updating event stats on update", result.reason, { tenant: req.tenant });
              }
            }
          });
        });
      }
    });
  }
};

module.exports = {
  registerEventQueueDbHandler,
};
