"use strict";

const VError = require("verror");

const ERROR_CODES = {
  WRONG_TX_USAGE: "WRONG_TX_USAGE",
};

const ERROR_CODES_META = {
  [ERROR_CODES.WRONG_TX_USAGE]: {
    message:
      "Usage of this.tx|this.context is not allowed if parallel event processing is enabled",
  },
};

class EventQueueError extends VError {
  constructor(...args) {
    super(args);
  }
  static wrongTxUsage(type, subType) {
    const { message } = ERROR_CODES_META[ERROR_CODES.WRONG_TX_USAGE];
    return new EventQueueError({
      name: ERROR_CODES.WRONG_TX_USAGE,
      info: { type, subType },
      message,
    });
  }
}

module.exports = EventQueueError;
