"use strict";

// TODO: how to deal with fatal logs
// TODO: add tests for config --> similar to csn check

module.exports = {
  ...require("./initialize"),
  config: require("./config"),
  ...require("./processEventQueue"),
  ...require("./dbHandler"),
  ...require("./constants"),
  ...require("./publishEvent"),
  EventQueueProcessorBase: require("./EventQueueProcessorBase"),
};
