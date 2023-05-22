"use strict";

const { promisify } = require("util");
const fs = require("fs");

const yaml = require("yaml");
const VError = require("verror");

const { getConfigInstance } = require("./config");
const { RunningModes } = require("./constants");
const runner = require("./runner");
const dbHandler = require("./dbHandler");
const { getAllTenantIds } = require("./shared/cdsHelper");
const { initEventQueueRedisSubscribe } = require("./redisPubSub");
const { Logger } = require("./shared/logger");
const { isOnCF } = require("./shared/env");

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
  const configInstance = getConfigInstance();
  if (configInstance.initialized) {
    return;
  }
  configInstance.initialized = true;
  cds.context = new cds.EventContext();
  configInstance.fileContent = await readConfigFromFile(configFilePath);
  configInstance.betweenRuns = betweenRuns;
  configInstance.redisEnabled = checkRedisIsBound() && isOnCF;
  configInstance.parallelTenantProcessing = parallelTenantProcessing;
  configInstance.tableNameEventQueue = tableNameEventQueue;
  configInstance.tableNameEventLock = tableNameEventLock;
  if (registerDbHandler) {
    const dbService = await cds.connect.to("db");
    dbHandler.registerEventQueueDbHandler(dbService);
  }
  const multiTenancyEnabled = await getAllTenantIds();
  if (mode === RunningModes.singleInstance) {
    // TODO: find a better way to determine this
    if (multiTenancyEnabled) {
      runner.singleInstanceAndMultiTenancy();
    } else {
      runner.singleInstanceAndTenant();
    }
  }
  if (mode === RunningModes.multiInstance) {
    initEventQueueRedisSubscribe();
    if (multiTenancyEnabled) {
      runner.multiInstanceAndTenancy();
    } else {
      runner.multiInstanceAndSingleTenancy();
    }
  }
  Logger(cds.context, COMPONENT).info("event queue initialized");
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

const checkRedisIsBound = () => {
  try {
    const services = JSON.parse(process.env.VCAP_SERVICES);
    return !!services["redis-cache"];
  } catch {
    return false;
  }
};

module.exports = {
  initialize,
};
