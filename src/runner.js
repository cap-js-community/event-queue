"use strict";

const uuid = require("uuid");

const eventQueueConfig = require("./config");
const cdsHelper = require("./shared/cdsHelper");
const { eventQueueRunner } = require("./processEventQueue");
const { Logger } = require("./shared/logger");
const distributedLock = require("./shared/distributedLock");
const { getWorkerPoolInstance } = require("./shared/WorkerQueue");

const COMPONENT_NAME = "eventQueue/runner";
const EVENT_QUEUE_RUN_ID = "EVENT_QUEUE_RUN_ID";
const OFFSET_FIRST_RUN = 10 * 1000;

const singleInstanceAndTenant = () => _scheduleFunction(_executeRunForTenant);

const singleInstanceAndMultiTenancy = () =>
  _scheduleFunction(_singleInstanceAndMultiTenancy);

const multiInstanceAndTenancy = () =>
  _scheduleFunction(_multiInstanceAndTenancy);

const multiInstanceAndSingleTenancy = () =>
  _scheduleFunction(_executeRunForTenant);

const _scheduleFunction = (fn) => {
  const configInstance = eventQueueConfig.getConfigInstance();
  setTimeout(() => {
    fn();
    setInterval(fn, configInstance.betweenRuns);
  }, OFFSET_FIRST_RUN);
};

const _multiInstanceAndTenancy = async () => {
  const emptyContext = new cds.EventContext({});
  const logger = Logger(emptyContext, COMPONENT_NAME);
  logger.info("executing event queue run for multi instance and tenant");
  const tenantIds = await cdsHelper.getAllTenantIds();
  const runId = await acquireRunId(emptyContext);

  if (!runId) {
    logger.error("could not acquire runId, skip processing events!");
    return;
  }

  _executeAllTenants(tenantIds, runId);
};

const _singleInstanceAndMultiTenancy = async () => {
  try {
    const emptyContext = new cds.EventContext({});
    const logger = Logger(emptyContext, COMPONENT_NAME);
    logger.info(
      "executing event queue run for single instance and multi tenant"
    );
    const tenantIds = await cdsHelper.getAllTenantIds();
    _executeAllTenants(tenantIds, EVENT_QUEUE_RUN_ID);
  } catch (err) {
    Logger(cds.context, COMPONENT_NAME).error(
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
          expiryTime: configInstance.betweenRuns * 0.9,
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
  try {
    const configInstance = eventQueueConfig.getConfigInstance();
    const eventsForAutomaticRun = configInstance.getEventsForAutomaticRuns();
    const subdomain = await cdsHelper.getSubdomainForTenantId(tenantId);
    const context = new cds.EventContext({
      tenant: tenantId,
      // NOTE: we need this because of logging otherwise logs would not contain the subdomain
      http: { req: { authInfo: { getSubdomain: () => subdomain } } },
    });
    Logger(context, COMPONENT_NAME).info("executing eventQueue run", {
      additionalMessageProperties: {
        tenantId,
        subdomain,
      },
    });
    await eventQueueRunner(context, eventsForAutomaticRun);
  } catch (err) {
    Logger(cds.context, COMPONENT_NAME).error(
      "Couldn't process eventQueue for tenant! Next try after defined interval.",
      {
        error: err,
        additionalMessageProperties: {
          tenantId,
          redisEnabled: false,
        },
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
      expiryTime: configInstance.betweenRuns * 0.9,
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
  singleInstanceAndTenant,
  singleInstanceAndMultiTenancy,
  multiInstanceAndTenancy,
  multiInstanceAndSingleTenancy,
  _: {
    _multiInstanceAndTenancy,
    _singleInstanceAndMultiTenancy,
  },
};
