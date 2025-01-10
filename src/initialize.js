"use strict";

const { promisify } = require("util");
const fs = require("fs");

const cds = require("@sap/cds");
const yaml = require("yaml");
const VError = require("verror");

const runner = require("./runner/runner");
const dbHandler = require("./dbHandler");
const config = require("./config");
const redisSub = require("./redis/redisSub");
const redis = require("./shared/redis");
const eventQueueAsOutbox = require("./outbox/eventQueueAsOutbox");
const { getAllTenantIds } = require("./shared/cdsHelper");
const { EventProcessingStatus } = require("./constants");
const distributedLock = require("./shared/distributedLock");
const EventQueueError = require("./EventQueueError");

const readFileAsync = promisify(fs.readFile);

const VERROR_CLUSTER_NAME = "EventQueueInitialization";
const COMPONENT = "eventQueue/initialize";
const TIMEOUT_SHUTDOWN = 2500;

const CONFIG_VARS = [
  ["configFilePath", null],
  ["registerAsEventProcessor", true],
  ["processEventsAfterPublish", true],
  ["isEventQueueActive", true],
  ["runInterval", 25 * 60 * 1000],
  ["disableRedis", true],
  ["updatePeriodicEvents", true],
  ["thresholdLoggingEventProcessing", 50],
  ["useAsCAPOutbox", false],
  ["userId", null],
  ["cleanupLocksAndEventsForDev", false],
  ["redisOptions", {}],
  ["insertEventsBeforeCommit", true],
  ["enableCAPTelemetry", false],
  ["cronTimezone", null],
  ["publishEventBlockList", true],
  ["crashOnRedisUnavailable", false],
  ["tenantIdFilterCb", null],
];

/**
 * Initializes the event queue with the provided options.
 *
 * @param {Object} options - The configuration options.
 * @param {string} [options.configFilePath=null] - Path to the configuration file.
 * @param {boolean} [options.registerAsEventProcessor=true] - Register the instance as an event processor.
 * @param {boolean} [options.processEventsAfterPublish=true] - Process events immediately after publishing.
 * @param {boolean} [options.isEventQueueActive=true] - Flag to activate/deactivate the event queue.
 * @param {number} [options.runInterval=1500000] - Interval for running event queue processing (in milliseconds).
 * @param {boolean} [options.disableRedis=true] - Disable Redis usage for event handling.
 * @param {boolean} [options.updatePeriodicEvents=true] - Automatically update periodic events.
 * @param {number} [options.thresholdLoggingEventProcessing=50] - Threshold for logging event processing time (in milliseconds).
 * @param {boolean} [options.useAsCAPOutbox=false] - Use the event queue as a CAP Outbox.
 * @param {string} [options.userId=null] - ID of the user initiating the process.
 * @param {boolean} [options.cleanupLocksAndEventsForDev=false] - Cleanup locks and events for development environments.
 * @param {Object} [options.redisOptions={}] - Configuration options for Redis.
 * @param {boolean} [options.insertEventsBeforeCommit=true] - Insert events into the queue before committing the transaction.
 * @param {boolean} [options.enableCAPTelemetry=false] - Enable telemetry for CAP.
 * @param {string} [options.cronTimezone=null] - Default timezone for cron jobs.
 * @param {string} [options.publishEventBlockList=true] - If redis is available event blocklist is distributed to all application instances
 * @param {string} [options.crashOnRedisUnavailable=true] - If enabled an error is thrown if the redis connection check is not successful
 * @param {function} [options.tenantIdFilterCb=null] - Allows to set customer filter function to filter the tenants ids which should be processed in the event-queue
 */
const initialize = async (options = {}) => {
  if (config.initialized) {
    return;
  }
  config.initialized = true;

  mixConfigVarsWithEnv(options);

  const logger = cds.log(COMPONENT);
  if (!config.useAsCAPOutbox && !config.configFilePath) {
    logger.info(
      "Event queue initialization skipped: no configFilePath provided, and event queue is not configured as a CAP outbox."
    );
  }

  const redisEnabled = config.checkRedisEnabled();
  let resolveFn;
  let initFinished = new Promise((resolve) => (resolveFn = resolve));
  cds.on("connect", (service) => {
    if (service.name === "db") {
      config.processEventsAfterPublish && dbHandler.registerEventQueueDbHandler(service);
      config.cleanupLocksAndEventsForDev && registerCleanupForDevDb().catch(() => {});
      initFinished.then(registerEventProcessors);
    }
  });
  if (redisEnabled) {
    config.redisEnabled = await redis.connectionCheck(config.redisOptions);
    if (!config.redisEnabled && config.crashOnRedisUnavailable) {
      throw EventQueueError.redisConnectionFailure();
    }
  }
  config.fileContent = await readConfigFromFile(config.configFilePath);

  monkeyPatchCAPOutbox();
  registerCdsShutdown();
  logger.info("event queue initialized", {
    registerAsEventProcessor: config.registerAsEventProcessor,
    processEventsAfterPublish: config.processEventsAfterPublish,
    multiTenancyEnabled: config.isMultiTenancy,
    redisEnabled: config.redisEnabled,
    runInterval: config.runInterval,
  });
  resolveFn();
};

const readConfigFromFile = async (configFilepath) => {
  try {
    const fileData = await readFileAsync(configFilepath);
    if (/\.ya?ml$/i.test(configFilepath)) {
      return yaml.parse(fileData.toString());
    }
    if (/\.json$/i.test(configFilepath)) {
      return JSON.parse(fileData.toString());
    }

    throw new VError(
      {
        name: VERROR_CLUSTER_NAME,
        info: { configFilepath },
      },
      "configFilepath with unsupported extension, allowed extensions are .yaml and .json"
    );
  } catch (err) {
    if (config.useAsCAPOutbox) {
      return {};
    }
    throw err;
  }
};

const registerEventProcessors = () => {
  _registerUnsubscribe();
  config.redisEnabled && config.attachRedisUnsubscribeHandler();

  if (!config.registerAsEventProcessor) {
    return;
  }

  const errorHandler = (err) => cds.log(COMPONENT).error("error during init runner", err);

  if (config.redisEnabled) {
    redisSub.initEventQueueRedisSubscribe();
    config.attachConfigChangeHandler();
    if (config.isMultiTenancy) {
      runner.multiTenancyRedis().catch(errorHandler);
    } else {
      runner.singleTenantRedis().catch(errorHandler);
    }
    return;
  }

  if (config.isMultiTenancy) {
    runner.multiTenancyDb().catch(errorHandler);
  } else {
    runner.singleTenantDb().catch(errorHandler);
  }
};

const monkeyPatchCAPOutbox = () => {
  if (config.useAsCAPOutbox) {
    Object.defineProperty(cds, "outboxed", {
      get: () => eventQueueAsOutbox.outboxed,
      configurable: true,
    });
    Object.defineProperty(cds, "unboxed", {
      get: () => eventQueueAsOutbox.unboxed,
      configurable: true,
    });
  }
};

const mixConfigVarsWithEnv = (options) => {
  CONFIG_VARS.forEach(([configName, defaultValue]) => {
    const configValue = options[configName];
    config[configName] = configValue ?? cds.env.eventQueue?.[configName] ?? defaultValue;
  });
};

const registerCdsShutdown = () => {
  const isTestProfile = cds.env.profiles.find((profile) => profile.includes("test"));
  if (isTestProfile) {
    return;
  }
  cds.on("shutdown", async () => {
    return await new Promise((resolve, reject) => {
      const timeoutRef = setTimeout(() => {
        clearTimeout(timeoutRef);
        cds.log(COMPONENT).info("shutdown timeout reached - some locks might not have been released!");
        resolve();
      }, TIMEOUT_SHUTDOWN);
      Promise.allSettled([distributedLock.shutdownHandler(), redis.closeMainClient(), redis.closeSubscribeClient()])
        .then((result) => {
          clearTimeout(timeoutRef);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timeoutRef);
          reject(err);
        });
    });
  });
};

const registerCleanupForDevDb = async () => {
  const profile = cds.env.profiles.find((profile) => profile === "development");
  if (!profile || process.env.NODE_ENV === "production") {
    return;
  }

  const tenantIds = await getAllTenantIds();
  for (const tenantId of tenantIds) {
    await cds.tx({ tenant: tenantId }, async (tx) => {
      await tx.run(DELETE.from(config.tableNameEventLock));
      await tx.run(
        UPDATE.entity(config.tableNameEventQueue).where({ status: EventProcessingStatus.InProgress }).set({
          status: EventProcessingStatus.Error,
        })
      );
    });
  }
};

const _registerUnsubscribe = () => {
  cds.on("listening", () => {
    cds.connect
      .to("cds.xt.DeploymentService")
      .then((ds) => {
        cds.log(COMPONENT).info("event-queue unsubscribe handler registered", {
          redisEnabled: config.redisEnabled,
        });
        ds.after("unsubscribe", async (_, req) => {
          const { tenant } = req.data;
          config.handleUnsubscribe(tenant);
        });
      })
      .catch(
        () => {} // ignore errors as the DeploymentService is most of the time only available in the mtx sidecar
      );
  });
};

module.exports = {
  initialize,
};
