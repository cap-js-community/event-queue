"use strict";

const path = require("path");
const { promisify } = require("util");
const fs = require("fs");

const yaml = require("yaml");
const VError = require("verror");
const { getConfigInstance } = require("./config");
const { RunningModes } = require("./constants");

const readFileAsync = promisify(fs.readFile);

// const COMPONENT_NAME = "/FeatureToggles";
const VERROR_CLUSTER_NAME = "EventQueueInitialization";

const initialize = async ({
  configFilePath,
  mode = RunningModes.singleInstance,
  redisEnabled = false,
  interval: { betweenRuns = 5 * 60 * 1000, betweenEvents = 100 } = {},
} = {}) => {
  const config = await readConfigFromFile(configFilePath);
  const configInstance = getConfigInstance();
  configInstance.fileContent = config;
  configInstance.betweenRuns = betweenRuns;
  configInstance.betweenEvents = betweenEvents;
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
