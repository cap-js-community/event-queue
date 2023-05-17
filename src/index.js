"use strict";

// TODO: how to deal with tx chaining - maybe inherit _ from context
// TODO: how to deal with fatal logs
// TODO: think about switching to cds.env from own config class
// TODO: add createdAt to persistence to proper order/sort event queue entries
// FIXME: Performance measurement executed\n{ name: undefined, milliseconds: 2776 }
// TODO: control concurrency for runner files
// TODO: modifyQueueEntry|checkEventAndGeneratePayload should not produce an unexpected error
// TODO: multiInstance without redis??
// TODO: runAutomatically: true flag in config

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
