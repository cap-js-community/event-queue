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
  registerAsEventProcessor = true,
  registerDbHandler = true,
  betweenRuns = 5 * 60 * 1000,
  parallelTenantProcessing = 5,
  tableNameEventQueue = BASE_TABLES.EVENT,
  tableNameEventLock = BASE_TABLES.LOCK,
  skipCsnCheck = false,
} = {}) => {
  // TODO: initialize check:
  // - content of yaml check
  // - betweenRuns and parallelTenantProcessing

  const configInstance = getConfigInstance();
  if (configInstance.initialized) {
    return;
  }
  configInstance.initialized = true;

  configFilePath = cds.env.eventQueue?.configFilePath ?? configFilePath;
  registerAsEventProcessor =
    cds.env.eventQueue?.registerAsEventProcessor ?? registerAsEventProcessor;
  registerDbHandler =
    cds.env.eventQueue?.registerDbHandler ?? registerDbHandler;
  betweenRuns = cds.env.eventQueue?.betweenRuns ?? betweenRuns;
  parallelTenantProcessing =
    cds.env.eventQueue?.parallelTenantProcessing ?? parallelTenantProcessing;
  tableNameEventQueue =
    cds.env.eventQueue?.tableNameEventQueue ?? tableNameEventQueue;
  tableNameEventLock =
    cds.env.eventQueue?.tableNameEventLock ?? tableNameEventLock;

  cds.context = new cds.EventContext();
  const logger = cds.log(COMPONENT);
  configInstance.fileContent = await readConfigFromFile(configFilePath);
  configInstance.betweenRuns = betweenRuns;
  configInstance.calculateIsRedisEnabled();
  configInstance.parallelTenantProcessing = parallelTenantProcessing;
  configInstance.tableNameEventQueue = tableNameEventQueue;
  configInstance.tableNameEventLock = tableNameEventLock;

  const dbService = await cds.connect.to("db");
  !skipCsnCheck && (await csnCheck(dbService));
  if (registerDbHandler) {
    dbHandler.registerEventQueueDbHandler(dbService);
  }

  registerEventProcessors(registerAsEventProcessor);
  logger.info("event queue initialized", {
    registerAsEventProcessor,
    multiTenancyEnabled: configInstance.isMultiTenancy,
    redisEnabled: configInstance.redisEnabled,
    betweenRuns,
    parallelTenantProcessing,
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

const registerEventProcessors = (registerAsEventProcessor) => {
  const configInstance = getConfigInstance();

  if (!registerAsEventProcessor) {
    return;
  }

  if (!configInstance.isMultiTenancy) {
    runner.singleTenant();
    return;
  }

  if (configInstance.redisEnabled) {
    initEventQueueRedisSubscribe();
    runner.multiTenancyRedis();
  } else {
    runner.multiTenancyDb();
  }
};

const csnCheck = async (dbService) => {
  const configInstance = getConfigInstance();
  const eventCsn =
    dbService.model.definitions[configInstance.tableNameEventQueue];
  if (!eventCsn) {
    throw EventQueueError.missingTableInCsn(configInstance.tableNameEventQueue);
  }

  const lockCsn =
    dbService.model.definitions[configInstance.tableNameEventLock];
  if (!lockCsn) {
    throw EventQueueError.missingTableInCsn(configInstance.tableNameEventLock);
  }

  if (
    configInstance.tableNameEventQueue === BASE_TABLES.EVENT &&
    configInstance.tableNameEventLock === BASE_TABLES.LOCK
  ) {
    return; // no need to check base tables
  }

  const csn = await cds.load(path.join(process.cwd(), "db"));
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
      customCsn.elements[columnName].type !== baseCsn.elements[columnName].type
    ) {
      throw EventQueueError.typeMismatchInTable(customCsn.name, columnName);
    }
  }
};

module.exports = {
  initialize,
};
