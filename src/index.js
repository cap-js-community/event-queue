"use strict";

// TODO: how to deal with fatal logs
// TODO: modifyQueueEntry|checkEventAndGeneratePayload should not produce an unexpected error
// TODO: returning exceeded is not a valid status
// TODO: wrong error msg "No Implementation found for queue type in 'eventTypeRegister.js'",
// TODO: replace req.tx._.afc.eventQueuePublishEvents
// TODO: check during init, that table is deployed/part of the csn
// TODO: set different table name

// FEATURES
// TODO: think about switching to cds.env from own config class

// TODO: for test
// --> deeper look into the functions e.g. getQueueEntriesAndSetToInProgress

module.exports = {
  ...require("./initialize"),
  ...require("./config"),
  ...require("./processEventQueue"),
  ...require("./dbHandler"),
  ...require("./constants"),
  ...require("./publishEvent"),
  EventQueueProcessorBase: require("./EventQueueProcessorBase"),
};
