"use strict";

const cds = require("@sap/cds");

const { promisify } = require("util");
const fs = require("fs");

const yaml = require("yaml");
const VError = require("verror");

const { getConfigInstance } = require("./config");
const { RunningModes } = require("./constants");
const runner = require("./runner");
const dbHandler = require("./dbHandler");
const { initEventQueueRedisSubscribe } = require("./redisPubSub");

const readFileAsync = promisify(fs.readFile);

const VERROR_CLUSTER_NAME = "EventQueueInitialization";
const COMPONENT = "eventQueue/initialize";

const initialize = async ({
  configFilePath,
  mode = RunningModes.singleInstance,
  registerDbHandler = true,
  betweenRuns = 5 * 60 * 1000,
  parallelTenantProcessing = 5,
  tableNameEventQueue = "sap.core.EventQueue",
  tableNameEventLock = "sap.core.EventLock",
} = {}) => {
  // Mix in cds.env.eventQueue
  configFilePath = cds.env.eventQueue?.configFilePath ?? configFilePath;
  mode = cds.env.eventQueue?.mode ?? mode;
  registerDbHandler =
    cds.env.eventQueue?.registerDbHandler ?? registerDbHandler;
  betweenRuns = cds.env.eventQueue?.betweenRuns ?? betweenRuns;
  parallelTenantProcessing =
    cds.env.eventQueue?.parallelTenantProcessing ?? parallelTenantProcessing;
  tableNameEventQueue =
    cds.env.eventQueue?.tableNameEventQueue ?? tableNameEventQueue;
  tableNameEventLock =
    cds.env.eventQueue?.tableNameEventLock ?? tableNameEventLock;

  // TODO: initialize check:
  // - csn check
  // - content of yaml check
  // - betweenRuns and parallelTenantProcessing

  const configInstance = getConfigInstance();
  if (configInstance.initialized) {
    return;
  }
  configInstance.initialized = true;
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

  const multiTenancyEnabled = cds.requires.multitenancy;
  if (mode === RunningModes.singleInstance || !configInstance.redisEnabled) {
    if (multiTenancyEnabled) {
      runner.singleInstanceAndMultiTenancy();
    } else {
      runner.singleInstanceAndTenant();
    }
  }
  if (mode === RunningModes.multiInstance && configInstance.redisEnabled) {
    initEventQueueRedisSubscribe();
    if (multiTenancyEnabled) {
      runner.multiInstanceAndTenancy();
    } else {
      runner.multiInstanceAndSingleTenancy();
    }
  }
  logger.info("event queue initialized", {
    mode,
    multiTenancyEnabled,
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

module.exports = {
  initialize,
};
