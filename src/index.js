"use strict";

// TODO: how to deal with fatal logs
// TODO: think about situations where isInitialized need to be checked - publishEvent access config which is not initialized

// TODO: for test
// --> deeper look into the functions e.g. getQueueEntriesAndSetToInProgress
// TODO: add tests for config
// TODO: add test for commit on event level and stuff like that

module.exports = {
  ...require("./initialize"),
  ...require("./config"),
  ...require("./processEventQueue"),
  ...require("./dbHandler"),
  ...require("./constants"),
  ...require("./publishEvent"),
  EventQueueProcessorBase: require("./EventQueueProcessorBase"),
};
