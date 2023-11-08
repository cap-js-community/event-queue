"use strict";

const { randomUUID } = require("crypto");

const eventQueueConfig = require("./config");
const { eventQueueRunner, processEventQueue } = require("./processEventQueue");
const { getWorkerPoolInstance } = require("./shared/WorkerQueue");
const cdsHelper = require("./shared/cdsHelper");
const distributedLock = require("./shared/distributedLock");
const SetIntervalDriftSafe = require("./shared/SetIntervalDriftSafe");
const { getSubdomainForTenantId } = require("./shared/cdsHelper");

const COMPONENT_NAME = "eventQueue/runner";
const EVENT_QUEUE_RUN_ID = "EVENT_QUEUE_RUN_ID";
const EVENT_QUEUE_RUN_TS = "EVENT_QUEUE_RUN_TS";
const OFFSET_FIRST_RUN = 10 * 1000;

const singleTenant = () => _scheduleFunction(_executeRunForTenant);

const multiTenancyDb = () => _scheduleFunction(_multiTenancyDb);

const multiTenancyRedis = () => _scheduleFunction(_multiTenancyRedis);

const _scheduleFunction = async (fn) => {
  const logger = cds.log(COMPONENT_NAME);
  const configInstance = eventQueueConfig.getConfigInstance();
  const eventsForAutomaticRun = configInstance.events;
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
    return fn();
  };

  const offsetDependingOnLastRun = await _calculateOffsetForFirstRun();

  logger.info("first event-queue run scheduled", {
    firstRunScheduledFor: new Date(Date.now() + offsetDependingOnLastRun).toISOString(),
  });

  setTimeout(() => {
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
  const runId = await _acquireRunId(emptyContext);

  if (!runId) {
    logger.error("could not acquire runId, skip processing events!");
    return;
  }

  _executeAllTenants(tenantIds, runId);
};

const _multiTenancyDb = async () => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    logger.info("executing event queue run for single instance and multi tenant");
    const tenantIds = await cdsHelper.getAllTenantIds();
    _executeAllTenants(tenantIds, EVENT_QUEUE_RUN_ID);
  } catch (err) {
    logger.error(
      `Couldn't fetch tenant ids for event queue processing! Next try after defined interval. Error: ${err}`
    );
  }
};

const _executeAllTenants = (tenantIds, runId) => {
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
        await _executeRunForTenant(tenantId, runId);
      } catch (err) {
        cds.log(COMPONENT_NAME).error("executing event-queue run for tenant failed", {
          tenantId,
        });
      }
    });
  });
};

const _executeRunForTenant = async (tenantId, runId) => {
  const logger = cds.log(COMPONENT_NAME);
  const configInstance = eventQueueConfig.getConfigInstance();
  try {
    const eventsForAutomaticRun = configInstance.events;
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

module.exports = {
  singleTenant,
  multiTenancyDb,
  multiTenancyRedis,
  _: {
    _multiTenancyRedis,
    _multiTenancyDb,
    _calculateOffsetForFirstRun,
    _acquireRunId,
    EVENT_QUEUE_RUN_TS,
  },
};
