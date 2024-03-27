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
  ["enableTxConsistencyCheck", false],
  ["cleanupLocksAndEventsForDev", false],
];

const initialize = async ({
  configFilePath,
  registerAsEventProcessor,
  processEventsAfterPublish,
  isEventQueueActive,
  runInterval,
  disableRedis,
  updatePeriodicEvents,
  thresholdLoggingEventProcessing,
  useAsCAPOutbox,
  userId,
  enableTxConsistencyCheck,
  cleanupLocksAndEventsForDev,
} = {}) => {
  if (config.initialized) {
    return;
  }
  config.initialized = true;

  mixConfigVarsWithEnv(
    configFilePath,
    registerAsEventProcessor,
    processEventsAfterPublish,
    isEventQueueActive,
    runInterval,
    disableRedis,
    updatePeriodicEvents,
    thresholdLoggingEventProcessing,
    useAsCAPOutbox,
    userId,
    enableTxConsistencyCheck,
    cleanupLocksAndEventsForDev
  );

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
    config.redisEnabled = await redis.connectionCheck();
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
    console.error("attach redis handler: %s", config.redisEnabled);
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

const mixConfigVarsWithEnv = (...args) => {
  CONFIG_VARS.forEach(([configName, defaultValue], index) => {
    const configValue = args[index];
    config[configName] = configValue ?? cds.env.eventQueue?.[configName] ?? defaultValue;
  });
};

const registerCdsShutdown = () => {
  cds.on("shutdown", async () => {
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

module.exports = {
  initialize,
};
