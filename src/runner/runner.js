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
const redisPub = require("../redis/redisPub");
const openEvents = require("./openEvents");
const { runEventCombinationForTenant } = require("./runnerHelper");

const COMPONENT_NAME = "/eventQueue/runner";
const EVENT_QUEUE_RUN_ID = "EVENT_QUEUE_RUN_ID";
const EVENT_QUEUE_RUN_TS = "EVENT_QUEUE_RUN_TS";
const EVENT_QUEUE_RUN_REDIS_CHECK = "EVENT_QUEUE_RUN_REDIS_CHECK";
const EVENT_QUEUE_UPDATE_PERIODIC_EVENTS = "EVENT_QUEUE_UPDATE_PERIODIC_EVENTS";
const OFFSET_FIRST_RUN = 10 * 1000;

let tenantIdHash;
let singleRunDone;

const singleTenant = () => _scheduleFunction(_checkPeriodicEventsSingleTenantOneTime, _singleTenantDb);

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
    logger.info("executing event queue run for multi instance and tenant");
    const tenantIds = await cdsHelper.getAllTenantIds();
    await _checkPeriodicEventUpdate(tenantIds);
    return await _executeEventsAllTenantsRedis(tenantIds);
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

const _executeEventsAllTenantsRedis = async (tenantIds) => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    // NOTE: do checks for all tenants on the same app instance --> acquire lock tenant independent
    //       distribute from this instance to all others
    const dummyContext = new cds.EventContext({});
    const couldAcquireLock = await distributedLock.acquireLock(dummyContext, EVENT_QUEUE_RUN_REDIS_CHECK, {
      expiryTime: eventQueueConfig.runInterval * 0.95,
      tenantScoped: false,
    });
    if (!couldAcquireLock) {
      return;
    }

    for (const tenantId of tenantIds) {
      await cds.tx({ tenant: tenantId }, async (tx) => {
        const entries = await openEvents.getOpenQueueEntries(tx);
        logger.info("broadcasting events for run", {
          tenantId,
          entries: entries.length,
        });
        if (!entries.length) {
          return;
        }
        await redisPub.broadcastEvent(tenantId, entries).catch((err) => {
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

const _executeEventsAllTenants = async (tenantIds, runId) => {
  const promises = [];

  for (const tenantId of tenantIds) {
    const subdomain = await getSubdomainForTenantId(tenantId);
    const user = new cds.User.Privileged(config.userId);
    const tenantContext = {
      tenant: tenantId,
      user,
      // NOTE: we need this because of logging otherwise logs would not contain the subdomain
      http: { req: { authInfo: { getSubdomain: () => subdomain } } },
    };
    const events = await cds.tx(tenantContext, async (tx) => {
      return await openEvents.getOpenQueueEntries(tx);
    });

    if (!events.length) {
      continue;
    }

    promises.concat(
      events.map(async (openEvent) => {
        const eventConfig = config.getEventConfig(openEvent.type, openEvent.subType);
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
  }
  return Promise.allSettled(promises);
};

const _executePeriodicEventsAllTenants = async (tenantIds) => {
  for (const tenantId of tenantIds) {
    try {
      const subdomain = await getSubdomainForTenantId(tenantId);
      const user = new cds.User.Privileged(config.userId);
      const tenantContext = {
        tenant: tenantId,
        user,
        // NOTE: we need this because of logging otherwise logs would not contain the subdomain
        http: { req: { authInfo: { getSubdomain: () => subdomain } } },
      };
      await cds.tx(tenantContext, async ({ context }) => {
        if (!config.redisEnabled) {
          const couldAcquireLock = await distributedLock.acquireLock(context, EVENT_QUEUE_UPDATE_PERIODIC_EVENTS, {
            expiryTime: eventQueueConfig.runInterval * 0.95,
          });
          if (!couldAcquireLock) {
            return;
          }
        }
        await _checkPeriodicEventsSingleTenant(context);
      });
    } catch (err) {
      cds.log(COMPONENT_NAME).error("executing event-queue run for tenant failed", {
        tenantId,
      });
    }
  }
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

    if (config.redisEnabled) {
      const dummyContext = new cds.EventContext({});
      const couldAcquireLock = await distributedLock.acquireLock(dummyContext, EVENT_QUEUE_UPDATE_PERIODIC_EVENTS, {
        expiryTime: 60 * 1000, // short living lock --> assume we do not have 2 onboards within 1 minute
        tenantScoped: false,
      });
      if (!couldAcquireLock) {
        return;
      }
    }

    tenantIds = tenantIds ?? (await cdsHelper.getAllTenantIds());
    return await _executePeriodicEventsAllTenants(tenantIds);
  } catch (err) {
    logger.error("Couldn't fetch tenant ids for updating periodic event processing!", err);
  }
};

const _checkPeriodicEventsSingleTenantOneTime = () =>
  cds.tx({}, async (tx) => await periodicEvents.checkAndInsertPeriodicEvents(tx.context));

const _checkPeriodicEventsSingleTenant = async (context) => {
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
    await periodicEvents.checkAndInsertPeriodicEvents(context);
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
