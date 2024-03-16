"use strict";

const { randomUUID } = require("crypto");
const { AsyncResource } = require("async_hooks");

const cds = require("@sap/cds");

const eventQueueConfig = require("../config");
const { processEventQueue } = require("../processEventQueue");
const WorkerQueue = require("../shared/WorkerQueue");
const cdsHelper = require("../shared/cdsHelper");
const distributedLock = require("../shared/distributedLock");
const SetIntervalDriftSafe = require("../shared/SetIntervalDriftSafe");
const { getSubdomainForTenantId } = require("../shared/cdsHelper");
const periodicEvents = require("../periodicEvents");
const { hashStringTo32Bit } = require("../shared/common");
const config = require("../config");
const { Priorities } = require("../constants");
const { broadcastEvent } = require("../redis/redisPub");
const { getOpenQueueEntries } = require("./openEvents");

const COMPONENT_NAME = "/eventQueue/runner";
const EVENT_QUEUE_RUN_ID = "EVENT_QUEUE_RUN_ID";
const EVENT_QUEUE_RUN_TS = "EVENT_QUEUE_RUN_TS";
const EVENT_QUEUE_RUN_REDIS_CHECK = "EVENT_QUEUE_RUN_REDIS_CHECK";
const EVENT_QUEUE_RUN_PERIODIC_EVENT = "EVENT_QUEUE_RUN_PERIODIC_EVENT";
const OFFSET_FIRST_RUN = 10 * 1000;

let tenantIdHash;
let singleRunDone;

const singleTenant = () => _scheduleFunction(_checkPeriodicEventsSingleTenant, _singleTenantDb);

const multiTenancyDb = () => _scheduleFunction(async () => {}, _multiTenancyDb);

const multiTenancyRedis = () => _scheduleFunction(async () => {}, _multiTenancyRedis);

const _scheduleFunction = async (singleRunFn, periodicFn) => {
  const logger = cds.log(COMPONENT_NAME);
  const eventsForAutomaticRun = eventQueueConfig.allEvents;
  if (!eventsForAutomaticRun.length) {
    logger.warn("no events for automatic run are configured - skipping runner registration");
    return;
  }

  const fnWithRunningCheck = () => {
    const logger = cds.log(COMPONENT_NAME);
    if (!eventQueueConfig.isEventQueueActive) {
      logger.info("runner is deactivated via config variable. Skipping this run.");
      return;
    }
    if (!singleRunDone) {
      singleRunDone = true;
      singleRunFn().catch(() => (singleRunDone = false));
    }
    return periodicFn();
  };

  const offsetDependingOnLastRun = await _calculateOffsetForFirstRun();

  logger.info("first event-queue run scheduled", {
    firstRunScheduledFor: new Date(Date.now() + offsetDependingOnLastRun).toISOString(),
  });

  setTimeout(() => {
    fnWithRunningCheck();
    const intervalRunner = new SetIntervalDriftSafe(eventQueueConfig.runInterval);
    intervalRunner.run(fnWithRunningCheck);
  }, offsetDependingOnLastRun).unref();
};

const _multiTenancyRedis = async () => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    const emptyContext = new cds.EventContext({});
    logger.info("executing event queue run for multi instance and tenant");
    const tenantIds = await cdsHelper.getAllTenantIds();
    await _checkPeriodicEventUpdate(tenantIds);

    const runId = await _acquireRunId(emptyContext);

    if (!runId) {
      logger.error("could not acquire runId, skip processing events!");
      return;
    }

    return await _executeEventsAllTenants(tenantIds, runId);
  } catch (err) {
    logger.info("executing event queue run for multi instance and tenant failed", err);
  }
};

const _checkPeriodicEventUpdate = async (tenantIds) => {
  const hash = hashStringTo32Bit(JSON.stringify(tenantIds));
  if (!tenantIdHash) {
    tenantIdHash = hash;
    return await _multiTenancyPeriodicEvents(tenantIds).catch((err) => {
      cds.log(COMPONENT_NAME).error("Error during triggering updating periodic events!", err);
    });
  }
  if (tenantIdHash && tenantIdHash !== hash) {
    tenantIdHash = hash;
    cds.log(COMPONENT_NAME).info("tenant id hash changed, triggering updating periodic events!");
    return await _multiTenancyPeriodicEvents(tenantIds).catch((err) => {
      cds.log(COMPONENT_NAME).error("Error during triggering updating periodic events!", err);
    });
  }
};

const _executeEventsAllTenantsRedis = async (tenantIds, runId) => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    const context = new cds.EventContext({});
    const lockId = `${runId}_${EVENT_QUEUE_RUN_REDIS_CHECK}`;
    const couldAcquireLock = await distributedLock.acquireLock(context, lockId, {
      expiryTime: eventQueueConfig.runInterval * 0.95,
    });
    if (!couldAcquireLock) {
      return;
    }

    for (const tenantId of tenantIds) {
      await cds.tx({ tenant: tenantId }, async (tx) => {
        const entries = await getOpenQueueEntries(tx);
        if (!entries.length) {
          return;
        }
        logger.info("broadcasting events for run", {
          tenantId,
          entries: entries.length,
        });
        await broadcastEvent(tenantId, entries).catch((err) => {
          logger.error("broadcasting event failed", err, {
            tenantId,
            entries: entries.length,
          });
        });
      });
    }
  } catch (err) {
    logger.info("executing event queue run for multi instance and tenant failed", err);
  }
};

const _executeEventsAllTenants = (tenantIds, runId) => {
  const events = eventQueueConfig.allEvents;
  const product = tenantIds.reduce((result, tenantId) => {
    events.forEach((event) => {
      result.push([tenantId, event]);
    });
    return result;
  }, []);

  return Promise.allSettled(
    product.map(async ([tenantId, eventConfig]) => {
      const subdomain = await getSubdomainForTenantId(tenantId);
      const user = new cds.User.Privileged(config.userId);
      const tenantContext = {
        tenant: tenantId,
        user,
        // NOTE: we need this because of logging otherwise logs would not contain the subdomain
        http: { req: { authInfo: { getSubdomain: () => subdomain } } },
      };
      const label = `${eventConfig.type}_${eventConfig.subType}`;
      return await WorkerQueue.instance.addToQueue(eventConfig.load, label, eventConfig.priority, async () => {
        return await cds.tx(tenantContext, async ({ context }) => {
          try {
            const lockId = `${runId}_${label}`;
            const couldAcquireLock = await distributedLock.acquireLock(context, lockId, {
              expiryTime: eventQueueConfig.runInterval * 0.95,
            });
            if (!couldAcquireLock) {
              return;
            }
            await runEventCombinationForTenant(context, eventConfig.type, eventConfig.subType, true);
          } catch (err) {
            cds.log(COMPONENT_NAME).error("executing event-queue run for tenant failed", {
              tenantId,
            });
          }
        });
      });
    })
  );
};

const _executePeriodicEventsAllTenants = async (tenantIds, runId) => {
  return await Promise.allSettled(
    tenantIds.map(async (tenantId) => {
      const label = `UPDATE_PERIODIC_EVENTS_${tenantId}`;
      return await WorkerQueue.instance.addToQueue(1, label, Priorities.Low, async () => {
        try {
          const subdomain = await getSubdomainForTenantId(tenantId);
          const user = new cds.User.Privileged(config.userId);
          const tenantContext = {
            tenant: tenantId,
            user,
            // NOTE: we need this because of logging otherwise logs would not contain the subdomain
            http: { req: { authInfo: { getSubdomain: () => subdomain } } },
          };

          return await cds.tx(tenantContext, async ({ context }) => {
            const couldAcquireLock = await distributedLock.acquireLock(context, runId, {
              expiryTime: eventQueueConfig.runInterval * 0.95,
            });
            if (!couldAcquireLock) {
              return;
            }
            await _checkPeriodicEventsSingleTenant(context);
          });
        } catch (err) {
          cds.log(COMPONENT_NAME).error("executing event-queue run for tenant failed", {
            tenantId,
          });
        }
      });
    })
  );
};

const _singleTenantDb = async (tenantId) => {
  return Promise.allSettled(
    eventQueueConfig.allEvents.map(async (eventConfig) => {
      const label = `${eventConfig.type}_${eventConfig.subType}`;
      const user = new cds.User.Privileged(config.userId);
      const tenantContext = {
        tenant: tenantId,
        user,
      };
      return await WorkerQueue.instance.addToQueue(eventConfig.load, label, eventConfig.priority, async () => {
        return await cds.tx(tenantContext, async ({ context }) => {
          try {
            const lockId = `${EVENT_QUEUE_RUN_ID}_${label}`;
            const couldAcquireLock = await distributedLock.acquireLock(context, lockId, {
              expiryTime: eventQueueConfig.runInterval * 0.95,
            });
            if (!couldAcquireLock) {
              return;
            }
            await runEventCombinationForTenant(context, eventConfig.type, eventConfig.subType, true);
          } catch (err) {
            cds.log(COMPONENT_NAME).error("executing event-queue run for tenant failed", {
              tenantId,
              redisEnabled: eventQueueConfig.redisEnabled,
            });
          }
        });
      });
    })
  );
};

const _acquireRunId = async (context) => {
  let runId = randomUUID();
  const couldSetValue = await distributedLock.setValueWithExpire(context, EVENT_QUEUE_RUN_ID, runId, {
    tenantScoped: false,
    expiryTime: eventQueueConfig.runInterval * 0.95,
  });

  if (couldSetValue) {
    await distributedLock.setValueWithExpire(context, EVENT_QUEUE_RUN_TS, new Date().toISOString(), {
      tenantScoped: false,
      expiryTime: eventQueueConfig.runInterval,
      overrideValue: true,
    });
  } else {
    runId = await distributedLock.checkLockExistsAndReturnValue(context, EVENT_QUEUE_RUN_ID, {
      tenantScoped: false,
    });
  }

  return runId;
};

const _calculateOffsetForFirstRun = async () => {
  let offsetDependingOnLastRun = OFFSET_FIRST_RUN;
  const now = Date.now();
  // NOTE: this is only supported with Redis, because this is a tenant agnostic information
  //       currently there is no proper place to store this information beside t0 schema
  try {
    if (eventQueueConfig.redisEnabled) {
      const dummyContext = new cds.EventContext({});
      let lastRunTs = await distributedLock.checkLockExistsAndReturnValue(dummyContext, EVENT_QUEUE_RUN_TS, {
        tenantScoped: false,
      });
      if (!lastRunTs) {
        const ts = new Date(now).toISOString();
        const couldSetValue = await distributedLock.setValueWithExpire(dummyContext, EVENT_QUEUE_RUN_TS, ts, {
          tenantScoped: false,
          expiryTime: eventQueueConfig.runInterval,
        });
        if (couldSetValue) {
          lastRunTs = ts;
        } else {
          lastRunTs = await distributedLock.checkLockExistsAndReturnValue(dummyContext, EVENT_QUEUE_RUN_TS, {
            tenantScoped: false,
          });
        }
      }
      offsetDependingOnLastRun = new Date(lastRunTs).getTime() + eventQueueConfig.runInterval - now;
    }
  } catch (err) {
    cds
      .log(COMPONENT_NAME)
      .error("calculating offset for first run failed, falling back to default. Runs might be out-of-sync.", err);
  }
  return offsetDependingOnLastRun;
};

const runEventCombinationForTenant = async (context, type, subType, skipWorkerPool) => {
  try {
    if (skipWorkerPool) {
      return await processEventQueue(context, type, subType);
    } else {
      const eventConfig = eventQueueConfig.getEventConfig(type, subType);
      const label = `${type}_${subType}`;
      return await WorkerQueue.instance.addToQueue(
        eventConfig.load,
        label,
        eventConfig.priority,
        AsyncResource.bind(async () => await processEventQueue(context, type, subType))
      );
    }
  } catch (err) {
    const logger = cds.log(COMPONENT_NAME);
    logger.error("error executing event combination for tenant", err, {
      tenantId: context.tenant,
      type,
      subType,
    });
  }
};

const _multiTenancyDb = async () => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    logger.info("executing event queue run for single instance and multi tenant");
    const tenantIds = await cdsHelper.getAllTenantIds();
    await _checkPeriodicEventUpdate(tenantIds);
    return await _executeEventsAllTenants(tenantIds, EVENT_QUEUE_RUN_ID);
  } catch (err) {
    logger.error("Couldn't fetch tenant ids for event queue processing! Next try after defined interval.", err);
  }
};

const _multiTenancyPeriodicEvents = async (tenantIds) => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    logger.info("executing event queue update periodic events");
    tenantIds = tenantIds ?? (await cdsHelper.getAllTenantIds());
    return await _executePeriodicEventsAllTenants(tenantIds, EVENT_QUEUE_RUN_PERIODIC_EVENT);
  } catch (err) {
    logger.error("Couldn't fetch tenant ids for updating periodic event processing!", err);
  }
};

const _checkPeriodicEventsSingleTenant = async (context = {}) => {
  const logger = cds.log(COMPONENT_NAME);
  if (!eventQueueConfig.updatePeriodicEvents || !eventQueueConfig.periodicEvents.length) {
    logger.info("updating of periodic events is disabled or no periodic events configured", {
      updateEnabled: eventQueueConfig.updatePeriodicEvents,
      events: eventQueueConfig.periodicEvents.length,
    });
    return;
  }
  try {
    logger.info("executing updating periodic events", {
      tenantId: context.tenant,
      subdomain: context.http?.req.authInfo.getSubdomain(),
    });
    await cdsHelper.executeInNewTransaction(context, "update-periodic-events", async (tx) => {
      await periodicEvents.checkAndInsertPeriodicEvents(tx.context);
    });
  } catch (err) {
    logger.error("Couldn't update periodic events for tenant! Next try after defined interval.", err, {
      tenantId: context.tenant,
      redisEnabled: eventQueueConfig.redisEnabled,
    });
  }
};

module.exports = {
  singleTenant,
  multiTenancyDb,
  multiTenancyRedis,
  runEventCombinationForTenant,
  __: {
    _singleTenantDb,
    _multiTenancyRedis,
    _multiTenancyDb,
    _calculateOffsetForFirstRun,
    _acquireRunId,
    EVENT_QUEUE_RUN_TS,
    clearHash: () => (tenantIdHash = null),
  },
};
