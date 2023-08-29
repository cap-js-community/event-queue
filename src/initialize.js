"use strict";

const { promisify } = require("util");
const fs = require("fs");
const path = require("path");

const cds = require("@sap/cds");

const yaml = require("yaml");
const VError = require("verror");

const EventQueueError = require("./EventQueueError");
const runner = require("./runner");
const dbHandler = require("./dbHandler");
const { getConfigInstance } = require("./config");
const { initEventQueueRedisSubscribe } = require("./redisPubSub");

const readFileAsync = promisify(fs.readFile);

const VERROR_CLUSTER_NAME = "EventQueueInitialization";
const COMPONENT = "eventQueue/initialize";
const BASE_TABLES = {
  EVENT: "sap.eventqueue.Event",
  LOCK: "sap.eventqueue.Lock",
};

const initialize = async ({
  configFilePath,
  registerAsEventProcessor,
  processEventsAfterPublish,
  isRunnerDeactivated,
  runInterval,
  parallelTenantProcessing,
  tableNameEventQueue,
  tableNameEventLock,
  skipCsnCheck,
} = {}) => {
  // TODO: initialize check:
  // - content of yaml check
  // - betweenRuns and parallelTenantProcessing

  const configInstance = getConfigInstance();
  if (configInstance.initialized) {
    return;
  }
  configInstance.initialized = true;

  mixConfigVarsWithEnv(
    configFilePath,
    registerAsEventProcessor,
    processEventsAfterPublish,
    isRunnerDeactivated,
    runInterval,
    parallelTenantProcessing,
    tableNameEventQueue,
    tableNameEventLock,
    skipCsnCheck
  );

  const logger = cds.log(COMPONENT);
  configInstance.fileContent = await readConfigFromFile(configInstance.configFilePath);
  configInstance.checkRedisEnabled();

  const dbService = await cds.connect.to("db");
  // TODO: remove this as soon as CDS fixes the current plugin model issues --> cds 7
  await (cds.model ? Promise.resolve() : new Promise((resolve) => {
        cds.on("loaded", () => {
          const checkModel = () => !!cds.model;
          if (checkModel()) {
            resolve();
          } else {
            setTimeout(checkModel, 10);
          }
        });
      }));
  !configInstance.skipCsnCheck && (await csnCheck());
  if (configInstance.processEventsAfterPublish) {
    dbHandler.registerEventQueueDbHandler(dbService);
  }

  registerEventProcessors();
  logger.info("event queue initialized", {
    registerAsEventProcessor: configInstance.registerAsEventProcessor,
    multiTenancyEnabled: configInstance.isMultiTenancy,
    redisEnabled: configInstance.redisEnabled,
    runInterval: configInstance.runInterval,
    parallelTenantProcessing: configInstance.parallelTenantProcessing,
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
  const configInstance = getConfigInstance();

  if (!configInstance.registerAsEventProcessor) {
    return;
  }

  if (!configInstance.isMultiTenancy) {
    runner.singleTenant();
    return;
  }

  if (configInstance.redisEnabled) {
    initEventQueueRedisSubscribe();
    configInstance.attachConfigChangeHandler();
    runner.multiTenancyRedis();
  } else {
    runner.multiTenancyDb();
  }
};

const csnCheck = async () => {
  const configInstance = getConfigInstance();
  const eventCsn = cds.model.definitions[configInstance.tableNameEventQueue];
  if (!eventCsn) {
    throw EventQueueError.missingTableInCsn(configInstance.tableNameEventQueue);
  }

  const lockCsn = cds.model.definitions[configInstance.tableNameEventLock];
  if (!lockCsn) {
    throw EventQueueError.missingTableInCsn(configInstance.tableNameEventLock);
  }

  if (
    configInstance.tableNameEventQueue === BASE_TABLES.EVENT &&
    configInstance.tableNameEventLock === BASE_TABLES.LOCK
  ) {
    return; // no need to check base tables
  }

  const csn = await cds.load(path.join(__dirname, "..", "db"));
  const baseEvent = csn.definitions["sap.eventqueue.Event"];
  const baseLock = csn.definitions["sap.eventqueue.Lock"];

  checkCustomTable(baseEvent, eventCsn);
  checkCustomTable(baseLock, lockCsn);
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

const mixConfigVarsWithEnv = (
  configFilePath,
  registerAsEventProcessor,
  processEventsAfterPublish,
  isRunnerDeactivated,
  runInterval,
  parallelTenantProcessing,
  tableNameEventQueue,
  tableNameEventLock,
  skipCsnCheck
) => {
  const configInstance = getConfigInstance();

  configInstance.configFilePath = configFilePath ?? cds.env.eventQueue?.configFilePath;
  configInstance.registerAsEventProcessor =
    registerAsEventProcessor ?? cds.env.eventQueue?.registerAsEventProcessor ?? true;
  configInstance.isRunnerDeactivated = isRunnerDeactivated ?? cds.env.eventQueue?.isRunnerDeactivated ?? false;
  configInstance.processEventsAfterPublish =
    processEventsAfterPublish ?? cds.env.eventQueue?.processEventsAfterPublish ?? true;
  configInstance.runInterval = runInterval ?? cds.env.eventQueue?.runInterval ?? 5 * 60 * 1000;
  configInstance.parallelTenantProcessing =
    parallelTenantProcessing ?? cds.env.eventQueue?.parallelTenantProcessing ?? 5;
  configInstance.tableNameEventQueue =
    tableNameEventQueue ?? cds.env.eventQueue?.tableNameEventQueue ?? BASE_TABLES.EVENT;
  configInstance.tableNameEventLock = tableNameEventLock ?? cds.env.eventQueue?.tableNameEventLock ?? BASE_TABLES.LOCK;
  configInstance.skipCsnCheck = skipCsnCheck ?? cds.env.eventQueue?.skipCsnCheck ?? false;
};

module.exports = {
  initialize,
};
