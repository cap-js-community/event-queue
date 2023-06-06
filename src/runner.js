"use strict";

const uuid = require("uuid");

const eventQueueConfig = require("./config");
const cdsHelper = require("./shared/cdsHelper");
const { eventQueueRunner } = require("./processEventQueue");
const distributedLock = require("./shared/distributedLock");
const { getWorkerPoolInstance } = require("./shared/WorkerQueue");

const COMPONENT_NAME = "eventQueue/runner";
const EVENT_QUEUE_RUN_ID = "EVENT_QUEUE_RUN_ID";
const OFFSET_FIRST_RUN = 10 * 1000;

const singleTenant = () => _scheduleFunction(_executeRunForTenant);

const multiTenancyDb = () => _scheduleFunction(_multiTenancyDb);

const multiTenancyRedis = () => _scheduleFunction(_multiTenancyRedis);

const _scheduleFunction = (fn) => {
  const configInstance = eventQueueConfig.getConfigInstance();
  const eventsForAutomaticRun = configInstance.getEventsForAutomaticRuns();
  if (!eventsForAutomaticRun.length) {
    cds
      .log(COMPONENT_NAME)
      .warn(
        "no events for automatic run are configured - skipping runner registration"
      );
    return;
  }

  const fnWithRunningCheck = () => {
    if (configInstance.isRunnerDeactivated) {
      cds
        .log(COMPONENT_NAME)
        .info("runner is deactivated via config variable. Skipping this run.");
      return;
    }
    return fn();
  };

  setTimeout(() => {
    fnWithRunningCheck();
    setInterval(fnWithRunningCheck, configInstance.runInterval);
  }, OFFSET_FIRST_RUN);
};

const _multiTenancyRedis = async () => {
  const emptyContext = new cds.EventContext({});
  const logger = cds.log(COMPONENT_NAME);
  logger.info("executing event queue run for multi instance and tenant");
  const tenantIds = await cdsHelper.getAllTenantIds();
  const runId = await acquireRunId(emptyContext);

  if (!runId) {
    logger.error("could not acquire runId, skip processing events!");
    return;
  }

  _executeAllTenants(tenantIds, runId);
};

const _multiTenancyDb = async () => {
  try {
    const logger = cds.log(COMPONENT_NAME);
    logger.info(
      "executing event queue run for single instance and multi tenant"
    );
    const tenantIds = await cdsHelper.getAllTenantIds();
    _executeAllTenants(tenantIds, EVENT_QUEUE_RUN_ID);
  } catch (err) {
    cds
      .log(COMPONENT_NAME)
      .error(
        "Couldn't fetch tenant ids for event queue processing! Next try after defined interval.",
        { error: err }
      );
  }
};

const _executeAllTenants = (tenantIds, acquireLockKey) => {
  const configInstance = eventQueueConfig.getConfigInstance();
  const workerQueueInstance = getWorkerPoolInstance();
  tenantIds.forEach((tenantId) => {
    workerQueueInstance.addToQueue(async () => {
      const tenantContext = new cds.EventContext({ tenant: tenantId });
      const couldAcquireLock = await distributedLock.acquireLock(
        tenantContext,
        acquireLockKey,
        {
          expiryTime: configInstance.runInterval * 0.9,
        }
      );
      if (!couldAcquireLock) {
        return;
      }
      await _executeRunForTenant(tenantId);
    });
  });
};

const _executeRunForTenant = async (tenantId) => {
  const configInstance = eventQueueConfig.getConfigInstance();
  try {
    const eventsForAutomaticRun = configInstance.getEventsForAutomaticRuns();
    const subdomain = await cdsHelper.getSubdomainForTenantId(tenantId);
    const context = new cds.EventContext({
      tenant: tenantId,
      // NOTE: we need this because of logging otherwise logs would not contain the subdomain
      http: { req: { authInfo: { getSubdomain: () => subdomain } } },
    });
    cds.context = context;
    cds.log(COMPONENT_NAME).info("executing eventQueue run", {
      tenantId,
      subdomain,
    });
    await eventQueueRunner(context, eventsForAutomaticRun);
  } catch (err) {
    cds
      .log(COMPONENT_NAME)
      .error(
        `Couldn't process eventQueue for tenant! Next try after defined interval. Error: ${err}`,
        {
          tenantId,
          redisEnabled: configInstance.redisEnabled,
        }
      );
  }
};

const acquireRunId = async (context) => {
  const configInstance = eventQueueConfig.getConfigInstance();
  let runId = uuid.v4();
  const couldSetValue = await distributedLock.setValueWithExpire(
    context,
    EVENT_QUEUE_RUN_ID,
    runId,
    {
      tenantScoped: false,
      expiryTime: configInstance.runInterval * 0.9,
    }
  );

  if (!couldSetValue) {
    runId = await distributedLock.checkLockExistsAndReturnValue(
      context,
      EVENT_QUEUE_RUN_ID,
      {
        tenantScoped: false,
      }
    );
  }

  return runId;
};

module.exports = {
  singleTenant,
  multiTenancyDb,
  multiTenancyRedis,
  _: {
    _multiTenancyRedis,
    _multiTenancyDb,
  },
};
