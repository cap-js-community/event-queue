"use strict";

const { randomUUID } = require("crypto");

const eventQueueConfig = require("./config");
const { processEventQueue } = require("./processEventQueue");
const WorkerQueue = require("./shared/WorkerQueue");
const cdsHelper = require("./shared/cdsHelper");
const distributedLock = require("./shared/distributedLock");
const SetIntervalDriftSafe = require("./shared/SetIntervalDriftSafe");
const { getSubdomainForTenantId } = require("./shared/cdsHelper");
const periodicEvents = require("./periodicEvents");
const { hashStringTo32Bit } = require("./shared/common");

const COMPONENT_NAME = "eventQueue/runner";
const EVENT_QUEUE_RUN_ID = "EVENT_QUEUE_RUN_ID";
const EVENT_QUEUE_RUN_TS = "EVENT_QUEUE_RUN_TS";
const EVENT_QUEUE_RUN_PERIODIC_EVENT = "EVENT_QUEUE_RUN_PERIODIC_EVENT";
const OFFSET_FIRST_RUN = 10 * 1000;

let tenantIdHash;
let singleRunDone;

const singleTenant = () => _scheduleFunction(_checkPeriodicEventsSingleTenant, _singleTenantDb);

const multiTenancyDb = () => _scheduleFunction(_multiTenancyPeriodicEvents, _multiTenancyDb);

const multiTenancyRedis = () => _scheduleFunction(_multiTenancyPeriodicEvents, _multiTenancyRedis);

const _scheduleFunction = async (singleRunFn, periodicFn) => {
  const logger = cds.log(COMPONENT_NAME);
  const eventsForAutomaticRun = eventQueueConfig.allEvents;
  if (!eventsForAutomaticRun.length) {
    logger.warn("no events for automatic run are configured - skipping runner registration");
    return;
  }

  const fnWithRunningCheck = () => {
    const logger = cds.log(COMPONENT_NAME);
    if (eventQueueConfig.isRunnerDeactivated) {
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
  const emptyContext = new cds.EventContext({});
  logger.info("executing event queue run for multi instance and tenant");
  const tenantIds = await cdsHelper.getAllTenantIds();
  _checkAndTriggerPeriodicEventUpdate(tenantIds);

  const runId = await _acquireRunId(emptyContext);

  if (!runId) {
    logger.error("could not acquire runId, skip processing events!");
    return;
  }

  return _executeEventsAllTenants(tenantIds, runId);
};

const _checkAndTriggerPeriodicEventUpdate = (tenantIds) => {
  const hash = hashStringTo32Bit(JSON.stringify(tenantIds));
  if (!tenantIdHash) {
    tenantIdHash = hash;
    return;
  }
  if (tenantIdHash && tenantIdHash !== hash) {
    cds.log(COMPONENT_NAME).info("tenant id hash changed, triggering updating periodic events!");
    _multiTenancyPeriodicEvents().catch((err) => {
      cds.log(COMPONENT_NAME).error("Error during triggering updating periodic events!", err);
    });
  }
};

const _executeEventsAllTenants = (tenantIds, runId) => {
  const events = eventQueueConfig.allEvents;
  const promises = [];
  tenantIds.forEach((tenantId) => {
    events.forEach((event) => {
      promises.push(async () => {
        const subdomain = await getSubdomainForTenantId(tenantId);
        const tenantContext = {
          tenant: tenantId,
          // NOTE: we need this because of logging otherwise logs would not contain the subdomain
          http: { req: { authInfo: { getSubdomain: () => subdomain } } },
        };
        return await cds.tx(tenantContext, ({ context }) => {
          WorkerQueue.instance.addToQueue(event.load, async () => {
            try {
              const lockId = `${runId}_${event.type}_${event.subType}`;
              const couldAcquireLock = await distributedLock.acquireLock(context, lockId, {
                expiryTime: eventQueueConfig.runInterval * 0.95,
              });
              if (!couldAcquireLock) {
                return;
              }
              await runEventCombinationForTenant(context, event.type, event.subType, true);
            } catch (err) {
              cds.log(COMPONENT_NAME).error("executing event-queue run for tenant failed", {
                tenantId,
              });
            }
          });
        });
      });
    });
  });
  return promises;
};

const _executePeriodicEventsAllTenants = (tenantIds, runId) => {
  tenantIds.forEach((tenantId) => {
    WorkerQueue.instance.addToQueue(1, async () => {
      try {
        const subdomain = await getSubdomainForTenantId(tenantId);
        const tenantContext = {
          tenant: tenantId,
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
  });
};

const _singleTenantDb = async (tenantId) => {
  const events = eventQueueConfig.allEvents;
  events.forEach((event) => {
    WorkerQueue.instance.addToQueue(event.load, async () => {
      try {
        const context = new cds.EventContext({ tenant: tenantId });
        await runEventCombinationForTenant(context, event.type, event.subType, true);
      } catch (err) {
        cds.log(COMPONENT_NAME).error("executing event-queue run for tenant failed", {
          tenantId,
          redisEnabled: eventQueueConfig.redisEnabled,
        });
      }
    });
  });
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
      const config = eventQueueConfig.getEventConfig(type, subType);
      return await WorkerQueue.instance.addToQueue(
        config.load,
        async () => await processEventQueue(context, type, subType)
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
    _checkAndTriggerPeriodicEventUpdate(tenantIds);
    return _executeEventsAllTenants(tenantIds, EVENT_QUEUE_RUN_ID);
  } catch (err) {
    logger.error("Couldn't fetch tenant ids for event queue processing! Next try after defined interval.", err);
  }
};

const _multiTenancyPeriodicEvents = async () => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    logger.info("executing event queue update periodic events");
    const tenantIds = await cdsHelper.getAllTenantIds();
    _executePeriodicEventsAllTenants(tenantIds, EVENT_QUEUE_RUN_PERIODIC_EVENT);
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
    logger.info("executing updating periotic events", {
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
  _: {
    _multiTenancyRedis,
    _multiTenancyDb,
    _calculateOffsetForFirstRun,
    _acquireRunId,
    EVENT_QUEUE_RUN_TS,
  },
};
