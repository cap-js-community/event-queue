"use strict";

// TODO: how to deal with fatal logs
// TODO: modifyQueueEntry|checkEventAndGeneratePayload should not produce an unexpected error
// TODO: returning exceeded is not a valid status
// TODO: wrong error msg "No Implementation found for queue type in 'eventTypeRegister.js'",
// TODO: check during init, that table is deployed/part of the csn
// TODO: think about situations where isInitialized need to be checked - publishEvent access config which is not initialized
// TODO: simplify modes --> production = multi, all others are single

// FEATURES
// TODO: think about switching to cds.env from own config class

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
