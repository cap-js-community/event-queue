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
const BASE_TABLES = { EVENT: "sap.eventqueue.Event", LOCK: "sap.eventqueue.Lock",
};

const initialize = async ({
  configFilePath,
  registerAsEventProcessor = true,
  processEventsAfterPublish = true,
  runInterval = 5 * 60 * 1000,
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
  processEventsAfterPublish =
    cds.env.eventQueue?.processEventsAfterPublish ?? processEventsAfterPublish;
  runInterval = cds.env.eventQueue?.runInterval ?? runInterval;
  parallelTenantProcessing =
    cds.env.eventQueue?.parallelTenantProcessing ?? parallelTenantProcessing;
  tableNameEventQueue =
    cds.env.eventQueue?.tableNameEventQueue ?? tableNameEventQueue;
  tableNameEventLock =
    cds.env.eventQueue?.tableNameEventLock ?? tableNameEventLock;
  skipCsnCheck = cds.env.eventQueue?.skipCsnCheck ?? skipCsnCheck;

  const logger = cds.log(COMPONENT);
  configInstance.fileContent = await readConfigFromFile(configFilePath);
  configInstance.runInterval = runInterval;
  configInstance.calculateIsRedisEnabled();
  configInstance.parallelTenantProcessing = parallelTenantProcessing;
  configInstance.tableNameEventQueue = tableNameEventQueue;
  configInstance.tableNameEventLock = tableNameEventLock;

  const dbService = await cds.connect.to("db");
  await (cds.model
    ? Promise.resolve()
    : new Promise((resolve) => cds.on("serving", resolve)));
  !skipCsnCheck && (await csnCheck());
  if (processEventsAfterPublish) {
    // TODO: remove this as soon as CDS fixes the current plugin model issues --> cds 7
    if (BASE_TABLES.EVENT === configInstance.tableNameEventQueue) {
      cds.db.model.definitions[BASE_TABLES.EVENT] =
        cds.model.definitions[BASE_TABLES.EVENT];
    }
    if (BASE_TABLES.LOCK === configInstance.tableNameEventLock) {
      cds.db.model.definitions[BASE_TABLES.LOCK] =
        cds.model.definitions[BASE_TABLES.LOCK];
    }
    dbHandler.registerEventQueueDbHandler(dbService);
  }

  registerEventProcessors(registerAsEventProcessor);
  logger.info("event queue initialized", {
    registerAsEventProcessor,
    multiTenancyEnabled: configInstance.isMultiTenancy,
    redisEnabled: configInstance.redisEnabled,
    runInterval,
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
      customCsn.elements[columnName].type !==
        baseCsn.elements[columnName].type &&
      columnName === "status" &&
      customCsn.elements[columnName].type !== "cds.Integer"
    ) {
      throw EventQueueError.typeMismatchInTable(customCsn.name, columnName);
    }
  }
};

module.exports = {
  initialize,
};
