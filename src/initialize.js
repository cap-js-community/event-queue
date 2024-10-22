"use strict";

const { promisify } = require("util");
const fs = require("fs");

const cds = require("@sap/cds");
const yaml = require("yaml");
const VError = require("verror");

const runner = require("./runner/runner");
const dbHandler = require("./dbHandler");
const config = require("./config");
const { initEventQueueRedisSubscribe, closeSubscribeClient } = require("./redis/redisSub");
const redis = require("./shared/redis");
const eventQueueAsOutbox = require("./outbox/eventQueueAsOutbox");
const { getAllTenantIds } = require("./shared/cdsHelper");
const { EventProcessingStatus } = require("./constants");
const distributedLock = require("./shared/distributedLock");

const readFileAsync = promisify(fs.readFile);

const VERROR_CLUSTER_NAME = "EventQueueInitialization";
const COMPONENT = "eventQueue/initialize";

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
  ["defaultTimezoneForCron", null],
  ["publishEventBlockList", true],
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
 * @param {string} [options.defaultTimezoneForCron=null] - Default timezone for cron jobs.
 * @param {string} [options.publishEventBlockList=true] - If redis is available event blocklist is distributed to all application instances
 */
const initialize = async (options = {}) => {
  if (config.initialized) {
    return;
  }
  config.initialized = true;

  mixConfigVarsWithEnv(options);

  const logger = cds.log(COMPONENT);
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

  if (!config.isMultiTenancy) {
    runner.singleTenant().catch(errorHandler);
    return;
  }

  if (config.redisEnabled) {
    initEventQueueRedisSubscribe();
    config.attachConfigChangeHandler();
    runner.multiTenancyRedis().catch(errorHandler);
  } else {
    runner.multiTenancyDb().catch(errorHandler);
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
  cds.on("shutdown", async () => {
    await distributedLock.shutdownHandler();
    await Promise.allSettled([redis.closeMainClient(), closeSubscribeClient()]);
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
