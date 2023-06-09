"use strict";

const uuid = require("uuid");

const eventQueueConfig = require("./config");
const cdsHelper = require("./shared/cdsHelper");
const { eventQueueRunner } = require("./processEventQueue");
const distributedLock = require("./shared/distributedLock");
const { getWorkerPoolInstance } = require("./shared/WorkerQueue");
const { getConfigInstance } = require("./config");

const COMPONENT_NAME = "eventQueue/runner";
const EVENT_QUEUE_RUN_ID = "EVENT_QUEUE_RUN_ID";
const EVENT_QUEUE_RUN_TS = "EVENT_QUEUE_RUN_TS";
const OFFSET_FIRST_RUN = 10 * 1000;

const singleTenant = () => _scheduleFunction(_executeRunForTenant);

const multiTenancyDb = () => _scheduleFunction(_multiTenancyDb);

const multiTenancyRedis = () => _scheduleFunction(_multiTenancyRedis);

const _scheduleFunction = async (fn) => {
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

  const offsetDependingOnLastRun = await _calculateOffsetForFirstRun();

  cds.log(COMPONENT_NAME).info("first event-queue run scheduled", {
    firstRunScheduledFor: new Date(
      Date.now() + offsetDependingOnLastRun
    ).toISOString(),
  });

  setTimeout(() => {
    fnWithRunningCheck();
    setInterval(fnWithRunningCheck, configInstance.runInterval).unref();
  }, offsetDependingOnLastRun).unref();
};

const _multiTenancyRedis = async () => {
  const emptyContext = new cds.EventContext({});
  const logger = cds.log(COMPONENT_NAME);
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

const _executeAllTenants = (tenantIds, runId) => {
  const configInstance = eventQueueConfig.getConfigInstance();
  const workerQueueInstance = getWorkerPoolInstance();
  tenantIds.forEach((tenantId) => {
    workerQueueInstance.addToQueue(async () => {
      const tenantContext = new cds.EventContext({ tenant: tenantId });
      const couldAcquireLock = await distributedLock.acquireLock(
        tenantContext,
        runId,
        {
          expiryTime: configInstance.runInterval * 0.9,
        }
      );
      if (!couldAcquireLock) {
        return;
      }
      await _executeRunForTenant(tenantId, runId);
    });
  });
};

const _executeRunForTenant = async (tenantId, runId) => {
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
      ...(runId ? { runId } : null),
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

const _acquireRunId = async (context) => {
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

  if (couldSetValue) {
    await distributedLock.setValueWithExpire(
      context,
      EVENT_QUEUE_RUN_TS,
      new Date().toISOString(),
      {
        tenantScoped: false,
        expiryTime: configInstance.runInterval * 0.9,
        overrideValue: true,
      }
    );
  } else {
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

const _calculateOffsetForFirstRun = async () => {
  const configInstance = getConfigInstance();
  let offsetDependingOnLastRun = OFFSET_FIRST_RUN;
  // NOTE: this is only supported with Redis, because this is a tenant agnostic information
  //       currently there is no proper place to store this information beside t0 schema
  try {
    if (configInstance.redisEnabled) {
      const dummyContext = new cds.EventContext({});
      let lastRunTs = await distributedLock.checkLockExistsAndReturnValue(
        dummyContext,
        EVENT_QUEUE_RUN_TS,
        { tenantScoped: false }
      );
      if (!lastRunTs) {
        const ts = new Date().toISOString();
        const couldSetValue = await distributedLock.setValueWithExpire(
          dummyContext,
          EVENT_QUEUE_RUN_TS,
          ts,
          {
            tenantScoped: false,
            expiryTime: configInstance.runInterval * 0.9,
          }
        );
        if (couldSetValue) {
          lastRunTs = ts;
        } else {
          lastRunTs = await distributedLock.checkLockExistsAndReturnValue(
            dummyContext,
            EVENT_QUEUE_RUN_TS,
            { tenantScoped: false }
          );
        }
      }
      offsetDependingOnLastRun =
        new Date(lastRunTs).getTime() + configInstance.runInterval - Date.now();
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
