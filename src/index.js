"use strict";

// TODO: how to deal with tx chaining - maybe inherit _ from context
// TODO: how to deal with fatal logs

module.exports = {
  ...require("./initialize"),
  ...require("./config"),
  ...require("./eventTypeRegister"),
  ...require("./processEventQueue"),
  ...require("./dbHandler"),
  EventQueueProcessorBase: require("./EventQueueProcessorBase"),
};
