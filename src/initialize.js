"use strict";

const cds = require("@sap/cds");

const { promisify } = require("util");
const fs = require("fs");

const yaml = require("yaml");
const VError = require("verror");

const { getConfigInstance } = require("./config");
const runner = require("./runner");
const dbHandler = require("./dbHandler");
const { initEventQueueRedisSubscribe } = require("./redisPubSub");

const readFileAsync = promisify(fs.readFile);

const VERROR_CLUSTER_NAME = "EventQueueInitialization";
const COMPONENT = "eventQueue/initialize";

const initialize = async ({
  configFilePath,
  registerAsEventProcessing = true,
  registerDbHandler = true,
  betweenRuns = 5 * 60 * 1000,
  parallelTenantProcessing = 5,
  tableNameEventQueue = "sap.eventqueue.Event",
  tableNameEventLock = "sap.eventqueue.Lock",
} = {}) => {
  // TODO: initialize check:
  // - csn check
  // - content of yaml check
  // - betweenRuns and parallelTenantProcessing

  const configInstance = getConfigInstance();
  if (configInstance.initialized) {
    return;
  }
  configInstance.initialized = true;

  // Mix in cds.env.eventQueue
  configFilePath = cds.env.eventQueue?.configFilePath ?? configFilePath;
  registerAsEventProcessing =
    cds.env.eventQueue?.registerAsEventProcessing ?? registerAsEventProcessing;
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
  if (registerDbHandler) {
    const dbService = await cds.connect.to("db");
    dbHandler.registerEventQueueDbHandler(dbService);
  }

  registerEventProcessors(registerAsEventProcessing);
  logger.info("event queue initialized", {
    registerAsEventProcessing,
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

const registerEventProcessors = (registerAsEventProcessing) => {
  const configInstance = getConfigInstance();

  if (!registerAsEventProcessing) {
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

module.exports = {
  initialize,
};
