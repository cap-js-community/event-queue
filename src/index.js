"use strict";

// TODO: how to deal with tx chaining - maybe inherit _ from context
// TODO: how to deal with fatal logs
// TODO: think about switching to cds.env from own config class

module.exports = {
  ...require("./initialize"),
  ...require("./config"),
  ...require("./eventTypeRegister"),
  ...require("./processEventQueue"),
  ...require("./dbHandler"),
  EventQueueProcessorBase: require("./EventQueueProcessorBase"),
};
