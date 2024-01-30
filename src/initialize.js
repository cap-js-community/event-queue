"use strict";

const { promisify } = require("util");
const fs = require("fs");

const cds = require("@sap/cds");
const yaml = require("yaml");
const VError = require("verror");

const EventQueueError = require("./EventQueueError");
const runner = require("./runner");
const dbHandler = require("./dbHandler");
const config = require("./config");
const { initEventQueueRedisSubscribe, closeSubscribeClient } = require("./redisPubSub");
const { closeMainClient } = require("./shared/redis");
const eventQueueAsOutbox = require("./outbox/eventQueueAsOutbox");

const readFileAsync = promisify(fs.readFile);

const VERROR_CLUSTER_NAME = "EventQueueInitialization";
const COMPONENT = "eventQueue/initialize";
const BASE_TABLES = {
  EVENT: "sap.eventqueue.Event",
  LOCK: "sap.eventqueue.Lock",
};
const CONFIG_VARS = [
  ["configFilePath", null],
  ["registerAsEventProcessor", true],
  ["processEventsAfterPublish", true],
  ["isEventQueueActive", true],
  ["runInterval", 5 * 60 * 1000],
  ["tableNameEventQueue", BASE_TABLES.EVENT],
  ["tableNameEventLock", BASE_TABLES.LOCK],
  ["disableRedis", false],
  ["skipCsnCheck", false],
  ["updatePeriodicEvents", true],
  ["thresholdLoggingEventProcessing", 50],
  ["useAsCAPOutbox", false],
  ["userId", null],
];

const initialize = async ({
  configFilePath,
  registerAsEventProcessor,
  processEventsAfterPublish,
  isEventQueueActive,
  runInterval,
  tableNameEventQueue,
  tableNameEventLock,
  disableRedis,
  skipCsnCheck,
  updatePeriodicEvents,
  thresholdLoggingEventProcessing,
  useAsCAPOutbox,
  userId,
} = {}) => {
  // TODO: initialize check:
  // - content of yaml check
  // - betweenRuns

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
    tableNameEventQueue,
    tableNameEventLock,
    disableRedis,
    skipCsnCheck,
    updatePeriodicEvents,
    thresholdLoggingEventProcessing,
    useAsCAPOutbox,
    userId
  );

  const logger = cds.log(COMPONENT);
  config.fileContent = await readConfigFromFile(config.configFilePath);
  config.checkRedisEnabled();

  if (config.processEventsAfterPublish) {
    cds.on("connect", (service) => {
      if (service.name === "db") {
        dbHandler.registerEventQueueDbHandler(service);
      }
    });
  }
  !config.skipCsnCheck && (await csnCheck());

  monkeyPatchCAPOutbox();
  registerEventProcessors();
  registerCdsShutdown();
  logger.info("event queue initialized", {
    registerAsEventProcessor: config.registerAsEventProcessor,
    processEventsAfterPublish: config.processEventsAfterPublish,
    multiTenancyEnabled: config.isMultiTenancy,
    redisEnabled: config.redisEnabled,
    runInterval: config.runInterval,
  });
};

const readConfigFromFile = async (configFilepath) => {
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
    });
    Object.defineProperty(cds, "unboxed", {
      get: () => eventQueueAsOutbox.unboxed,
    });
  }
};

const csnCheck = async () => {
  cds.on("loaded", async (csn) => {
    if (csn.namespace === "cds.xt") {
      return;
    }
    const eventCsn = csn.definitions[config.tableNameEventQueue];
    if (!eventCsn) {
      throw EventQueueError.missingTableInCsn(config.tableNameEventQueue);
    }

    const lockCsn = csn.definitions[config.tableNameEventLock];
    if (!lockCsn) {
      throw EventQueueError.missingTableInCsn(config.tableNameEventLock);
    }

    if (config.tableNameEventQueue === BASE_TABLES.EVENT && config.tableNameEventLock === BASE_TABLES.LOCK) {
      return; // no need to check base tables
    }

    const baseEvent = csn.definitions["sap.eventqueue.Event"];
    const baseLock = csn.definitions["sap.eventqueue.Lock"];

    checkCustomTable(baseEvent, eventCsn);
    checkCustomTable(baseLock, lockCsn);
  });
};

const checkCustomTable = (baseCsn, customCsn) => {
  for (const columnName in baseCsn.elements) {
    if (!customCsn.elements[columnName]) {
      throw EventQueueError.missingElementInTable(customCsn.name, columnName);
    }

    if (
      customCsn.elements[columnName].type !== "cds.Association" &&
      customCsn.elements[columnName].type !== baseCsn.elements[columnName].type &&
      columnName === "status" &&
      customCsn.elements[columnName].type !== "cds.Integer"
    ) {
      throw EventQueueError.typeMismatchInTable(customCsn.name, columnName);
    }
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
    await Promise.allSettled([closeMainClient(), closeSubscribeClient()]);
  });
};

module.exports = {
  initialize,
};
