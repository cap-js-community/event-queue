"use strict";

// TODO: how to deal with tx chaining - maybe inherit _ from context
// TODO: how to deal with fatal logs
// TODO: modifyQueueEntry|checkEventAndGeneratePayload should not produce an unexpected error

// FEATURES
// TODO: think about switching to cds.env from own config class
// TODO: multiInstance without redis??
// TODO: control concurrency for runner files
// TODO: add createdAt to persistence to proper order/sort event queue entries

// TODO: for test
// --> deeper look into the functions e.g. getQueueEntriesAndSetToInProgress
// find a good way to test tx handling with sqlite --> commits/rollbacks should be validated

module.exports = {
  ...require("./initialize"),
  ...require("./config"),
  ...require("./eventTypeRegister"),
  ...require("./processEventQueue"),
  ...require("./dbHandler"),
  ...require("./constants"),
  ...require("./publishEvent"),
  EventQueueProcessorBase: require("./EventQueueProcessorBase"),
};
