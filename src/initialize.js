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
  ["events", null, "configEvents"],
  ["periodicEvents", null, "configPeriodicEvents"],
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
  ["enableTelemetry", true],
  ["cronTimezone", null],
  ["randomOffsetPeriodicEvents", null],
  ["redisNamespace", null],
  ["publishEventBlockList", true],
  ["crashOnRedisUnavailable", false],
  ["enableAdminService", false],
];

/**
 * Initializes the event queue with the provided options.
 *
 * @param {Object} options - The configuration options.
 * @param {string} [options.configFilePath=null] - Path to the configuration file.
 * @param {string} [options.events={}] - Options to allow events in the configuration.
 * @param {string} [options.periodicEvents={}] - Options to allow periodicEvents in the configuration.
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
 * @param {boolean} [options.enableTelemetry=false] - Enable telemetry for CAP.
 * @param {string} [options.cronTimezone=null] - Default timezone for cron jobs.
 * @param {string} [options.randomOffsetPeriodicEvents=null] - Default random offset for periodic events.
 * @param {string} [options.publishEventBlockList=true] - If redis is available event blocklist is distributed to all application instances
 * @param {string} [options.crashOnRedisUnavailable=true] - If enabled an error is thrown if the redis connection check is not successful
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
  _disableAdminService();
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
  const fileContent = await readConfigFromFile(config.configFilePath);
  config.mixFileContentWithEnv(fileContent);

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
    if (!configFilepath && (config.useAsCAPOutbox || config.hasConfigEvents)) {
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
    Object.defineProperty(cds, "queued", {
      get: () => eventQueueAsOutbox.outboxed,
      configurable: true,
    });
    Object.defineProperty(cds, "unqueued", {
      get: () => eventQueueAsOutbox.unboxed,
      configurable: true,
    });
  }
};

const mixConfigVarsWithEnv = (options) => {
  CONFIG_VARS.forEach(([configName, defaultValue, mappingName]) => {
    const configValue = options[configName];
    config[mappingName ?? configName] = configValue ?? cds.env.eventQueue?.[configName] ?? defaultValue;
  });
};

const registerCdsShutdown = () => {
  cds.on("shutdown", async () => {
    return await new Promise((resolve) => {
      let timeoutRef;
      timeoutRef = setTimeout(() => {
        clearTimeout(timeoutRef);
        cds.log(COMPONENT).info("shutdown timeout reached - some locks might not have been released!");
        resolve();
      }, TIMEOUT_SHUTDOWN);
      distributedLock.shutdownHandler().then(() => {
        Promise.allSettled(
          config.redisEnabled ? [redis.closeMainClient(), redis.closeSubscribeClient()] : [Promise.resolve()]
        ).then((result) => {
          clearTimeout(timeoutRef);
          resolve(result);
        });
      });
    });
  });
};

const registerCleanupForDevDb = async () => {
  if (!config.developmentMode) {
    return;
  }
  const tenantIds = config.isMultiTenancy ? await getAllTenantIds() : [null];
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

const _disableAdminService = () => {
  if (config.enableAdminService) {
    return;
  }
  cds.on("loaded", (model) => {
    const srvDefinition = model.definitions["EventQueueAdminService"];
    if (srvDefinition) {
      srvDefinition["@protocol"] = "none";
    }
  });
};

module.exports = {
  initialize,
};
