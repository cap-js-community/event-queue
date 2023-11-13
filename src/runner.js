"use strict";

const { randomUUID } = require("crypto");

const eventQueueConfig = require("./config");
const { eventQueueRunner, processEventQueue } = require("./processEventQueue");
const { getWorkerPoolInstance } = require("./shared/WorkerQueue");
const cdsHelper = require("./shared/cdsHelper");
const distributedLock = require("./shared/distributedLock");
const SetIntervalDriftSafe = require("./shared/SetIntervalDriftSafe");
const { getSubdomainForTenantId } = require("./shared/cdsHelper");
const { checkAndInsertPeriodicEvents } = require("./checkAndInsertPeriodicEvents");
const { hashStringTo32Bit } = require("./shared/common");

const COMPONENT_NAME = "eventQueue/runner";
const EVENT_QUEUE_RUN_ID = "EVENT_QUEUE_RUN_ID";
const EVENT_QUEUE_RUN_TS = "EVENT_QUEUE_RUN_TS";
const EVENT_QUEUE_RUN_PERIODIC_EVENT = "EVENT_QUEUE_RUN_PERIODIC_EVENT";
const OFFSET_FIRST_RUN = 10 * 1000;

let tenantIdHash;

const singleTenant = () => _scheduleFunction(_checkPeriodicEventsSingleTenant, _executeRunForTenant);

const multiTenancyDb = () => _scheduleFunction(_multiTenancyPeriodicEvents, _multiTenancyDb);

const multiTenancyRedis = () => _scheduleFunction(_multiTenancyPeriodicEvents, _multiTenancyRedis);

const _scheduleFunction = async (singleRunFn, periodicFn) => {
  const logger = cds.log(COMPONENT_NAME);
  const configInstance = eventQueueConfig.getConfigInstance();
  const eventsForAutomaticRun = configInstance.allEvents;
  if (!eventsForAutomaticRun.length) {
    logger.warn("no events for automatic run are configured - skipping runner registration");
    return;
  }

  const fnWithRunningCheck = () => {
    const logger = cds.log(COMPONENT_NAME);
    if (configInstance.isRunnerDeactivated) {
      logger.info("runner is deactivated via config variable. Skipping this run.");
      return;
    }
    return periodicFn();
  };

  const offsetDependingOnLastRun = await _calculateOffsetForFirstRun();

  logger.info("first event-queue run scheduled", {
    firstRunScheduledFor: new Date(Date.now() + offsetDependingOnLastRun).toISOString(),
  });

  setTimeout(() => {
    singleRunFn();
    fnWithRunningCheck();
    const intervalRunner = new SetIntervalDriftSafe(configInstance.runInterval);
    intervalRunner.run(fnWithRunningCheck);
  }, offsetDependingOnLastRun).unref();
};

const _multiTenancyRedis = async () => {
  const logger = cds.log(COMPONENT_NAME);
  const emptyContext = new cds.EventContext({});
  logger.info("executing event queue run for multi instance and tenant");
  const tenantIds = await cdsHelper.getAllTenantIds();
  _checkAndTriggerPriodicEventUpdate(tenantIds);

  const runId = await _acquireRunId(emptyContext);

  if (!runId) {
    logger.error("could not acquire runId, skip processing events!");
    return;
  }

  _executeAllTenants(tenantIds, runId);
};

const _checkAndTriggerPriodicEventUpdate = (tenantIds) => {
  const hash = hashStringTo32Bit(JSON.stringify(tenantIds));
  if (!tenantIdHash) {
    tenantIdHash = hash;
    return;
  }
  if (tenantIdHash && tenantIdHash !== hash) {
    cds.log(COMPONENT_NAME).info("tenant id hash changed, triggering updating periodic events!");
    _multiTenancyPeriodicEvents().catch((err) => {
      cds.log(COMPONENT_NAME).error("Error during triggering updating periodic events! Error:", err);
    });
  }
};

const _executeAllTenantsGeneric = (tenantIds, runId, fn) => {
  const configInstance = eventQueueConfig.getConfigInstance();
  const workerQueueInstance = getWorkerPoolInstance();
  tenantIds.forEach((tenantId) => {
    workerQueueInstance.addToQueue(async () => {
      try {
        const tenantContext = new cds.EventContext({ tenant: tenantId });
        const couldAcquireLock = await distributedLock.acquireLock(tenantContext, runId, {
          expiryTime: configInstance.runInterval * 0.95,
        });
        if (!couldAcquireLock) {
          return;
        }
        await fn(tenantId, runId);
      } catch (err) {
        cds.log(COMPONENT_NAME).error("executing event-queue run for tenant failed", {
          tenantId,
        });
      }
    });
  });
};

const _executeAllTenants = (tenantIds, runId) => _executeAllTenantsGeneric(tenantIds, runId, _executeRunForTenant);

const _executePeriodicEventsAllTenants = (tenantIds, runId) =>
  _executeAllTenantsGeneric(tenantIds, runId, _checkPeriodicEventsSingleTenant);

const _executeRunForTenant = async (tenantId, runId) => {
  const logger = cds.log(COMPONENT_NAME);
  const configInstance = eventQueueConfig.getConfigInstance();
  try {
    const eventsForAutomaticRun = configInstance.allEvents;
    const subdomain = await cdsHelper.getSubdomainForTenantId(tenantId);
    const context = new cds.EventContext({
      tenant: tenantId,
      // NOTE: we need this because of logging otherwise logs would not contain the subdomain
      http: { req: { authInfo: { getSubdomain: () => subdomain } } },
    });
    cds.context = context;
    logger.info("executing eventQueue run", {
      tenantId,
      subdomain,
      ...(runId ? { runId } : null),
    });
    await eventQueueRunner(context, eventsForAutomaticRun);
  } catch (err) {
    logger.error(`Couldn't process eventQueue for tenant! Next try after defined interval. Error: ${err}`, {
      tenantId,
      redisEnabled: configInstance.redisEnabled,
    });
  }
};

const _acquireRunId = async (context) => {
  const configInstance = eventQueueConfig.getConfigInstance();
  let runId = randomUUID();
  const couldSetValue = await distributedLock.setValueWithExpire(context, EVENT_QUEUE_RUN_ID, runId, {
    tenantScoped: false,
    expiryTime: configInstance.runInterval * 0.95,
  });

  if (couldSetValue) {
    await distributedLock.setValueWithExpire(context, EVENT_QUEUE_RUN_TS, new Date().toISOString(), {
      tenantScoped: false,
      expiryTime: configInstance.runInterval,
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
  const configInstance = eventQueueConfig.getConfigInstance();
  let offsetDependingOnLastRun = OFFSET_FIRST_RUN;
  const now = Date.now();
  // NOTE: this is only supported with Redis, because this is a tenant agnostic information
  //       currently there is no proper place to store this information beside t0 schema
  try {
    if (configInstance.redisEnabled) {
      const dummyContext = new cds.EventContext({});
      let lastRunTs = await distributedLock.checkLockExistsAndReturnValue(dummyContext, EVENT_QUEUE_RUN_TS, {
        tenantScoped: false,
      });
      if (!lastRunTs) {
        const ts = new Date(now).toISOString();
        const couldSetValue = await distributedLock.setValueWithExpire(dummyContext, EVENT_QUEUE_RUN_TS, ts, {
          tenantScoped: false,
          expiryTime: configInstance.runInterval,
        });
        if (couldSetValue) {
          lastRunTs = ts;
        } else {
          lastRunTs = await distributedLock.checkLockExistsAndReturnValue(dummyContext, EVENT_QUEUE_RUN_TS, {
            tenantScoped: false,
          });
        }
      }
      offsetDependingOnLastRun = new Date(lastRunTs).getTime() + configInstance.runInterval - now;
    }
  } catch (err) {
    cds
      .log(COMPONENT_NAME)
      .error(
        "calculating offset for first run failed, falling back to default. Runs might be out-of-sync. Error:",
        err
      );
  }
  return offsetDependingOnLastRun;
};

const runEventCombinationForTenant = async (tenantId, type, subType) => {
  try {
    const subdomain = await getSubdomainForTenantId(tenantId);
    const context = new cds.EventContext({
      tenant: tenantId,
      // NOTE: we need this because of logging otherwise logs would not contain the subdomain
      http: { req: { authInfo: { getSubdomain: () => subdomain } } },
    });
    cds.context = context;
    getWorkerPoolInstance().addToQueue(async () => await processEventQueue(context, type, subType));
  } catch (err) {
    const logger = cds.log(COMPONENT_NAME);
    logger.error("error executing event combination for tenant", err, {
      tenantId,
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
    _checkAndTriggerPriodicEventUpdate(tenantIds);
    _executeAllTenants(tenantIds, EVENT_QUEUE_RUN_ID);
  } catch (err) {
    logger.error(
      `Couldn't fetch tenant ids for event queue processing! Next try after defined interval. Error: ${err}`
    );
  }
};

const _multiTenancyPeriodicEvents = async () => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    logger.info("executing event queue update periodic events");
    const tenantIds = await cdsHelper.getAllTenantIds();
    _executePeriodicEventsAllTenants(tenantIds, EVENT_QUEUE_RUN_PERIODIC_EVENT);
  } catch (err) {
    logger.error(`Couldn't fetch tenant ids for updating periodic event processing! Error: ${err}`);
  }
};

const _checkPeriodicEventsSingleTenant = async (tenantId) => {
  const logger = cds.log(COMPONENT_NAME);
  const configInstance = eventQueueConfig.getConfigInstance();
  if (!configInstance.updatePeriodicEvents) {
    logger.info("updating of periodic events is disabled");
  }
  try {
    const subdomain = await cdsHelper.getSubdomainForTenantId(tenantId);
    const context = new cds.EventContext({
      tenant: tenantId,
      // NOTE: we need this because of logging otherwise logs would not contain the subdomain
      http: { req: { authInfo: { getSubdomain: () => subdomain } } },
    });
    cds.context = context;
    logger.info("executing updating periotic events", {
      tenantId,
      subdomain,
    });
    await cdsHelper.executeInNewTransaction(context, "update-periodic-events", async (tx) => {
      await checkAndInsertPeriodicEvents(tx.context);
    });
  } catch (err) {
    logger.error(`Couldn't process eventQueue for tenant! Next try after defined interval. Error: ${err}`, {
      tenantId,
      redisEnabled: configInstance.redisEnabled,
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
