"use strict";

const VError = require("verror");

const ERROR_CODES = {
  WRONG_TX_USAGE: "WRONG_TX_USAGE",
  UNKNOWN_EVENT_TYPE: "UNKNOWN_EVENT_TYPE",
  NOT_INITIALIZED: "NOT_INITIALIZED",
  REDIS_CREATE_CLIENT: "REDIS_CREATE_CLIENT",
  REDIS_LOCAL_NO_RECONNECT: "REDIS_LOCAL_NO_RECONNECT",
};

const ERROR_CODES_META = {
  [ERROR_CODES.WRONG_TX_USAGE]: {
    message:
      "Usage of this.tx|this.context is not allowed if parallel event processing is enabled",
  },
  [ERROR_CODES.UNKNOWN_EVENT_TYPE]: {
    message:
      "The event type and subType configuration is not configured! Maintain the combination in the config file.",
  },
  [ERROR_CODES.NOT_INITIALIZED]: {
    message:
      "The event-queue is not initialized yet. The initialization needs to be completed before the package is used.",
  },
  [ERROR_CODES.REDIS_CREATE_CLIENT]: {
    message: "error during create client with redis-cache service",
  },
  [ERROR_CODES.REDIS_LOCAL_NO_RECONNECT]: {
    message: "disabled reconnect, because we are not running on cloud foundry",
  },
};

class EventQueueError extends VError {
  constructor(...args) {
    super(...args);
  }

  static wrongTxUsage(type, subType) {
    const { message } = ERROR_CODES_META[ERROR_CODES.WRONG_TX_USAGE];
    return new EventQueueError(
      {
        name: ERROR_CODES.WRONG_TX_USAGE,
        info: { type, subType },
      },
      message
    );
  }

  static unknownEventType(type, subType) {
    const { message } = ERROR_CODES_META[ERROR_CODES.UNKNOWN_EVENT_TYPE];
    return new EventQueueError(
      {
        name: ERROR_CODES.UNKNOWN_EVENT_TYPE,
        info: { type, subType },
      },
      message
    );
  }

  static notInitialized() {
    const { message } = ERROR_CODES_META[ERROR_CODES.NOT_INITIALIZED];
    return new EventQueueError(
      {
        name: ERROR_CODES.NOT_INITIALIZED,
      },
      message
    );
  }

  static redisConnectionFailure(err) {
    const { message } = ERROR_CODES_META[ERROR_CODES.REDIS_CREATE_CLIENT];
    return new EventQueueError(
      {
        name: ERROR_CODES.REDIS_CREATE_CLIENT,
        cause: err,
      },
      message
    );
  }

  static redisNoReconnect() {
    const { message } = ERROR_CODES_META[ERROR_CODES.REDIS_LOCAL_NO_RECONNECT];
    return new EventQueueError(
      {
        name: ERROR_CODES.REDIS_LOCAL_NO_RECONNECT,
      },
      message
    );
  }
}

module.exports = EventQueueError;
