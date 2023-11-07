"use strict";

const VError = require("verror");

const ERROR_CODES = {
  WRONG_TX_USAGE: "WRONG_TX_USAGE",
  UNKNOWN_EVENT_TYPE: "UNKNOWN_EVENT_TYPE",
  NOT_INITIALIZED: "NOT_INITIALIZED",
  REDIS_CREATE_CLIENT: "REDIS_CREATE_CLIENT",
  REDIS_LOCAL_NO_RECONNECT: "REDIS_LOCAL_NO_RECONNECT",
  MISSING_TABLE_DEFINITION: "MISSING_TABLE_DEFINITION",
  MISSING_ELEMENT_IN_TABLE: "MISSING_ELEMENT_IN_TABLE",
  TYPE_MISMATCH_TABLE: "TYPE_MISMATCH_TABLE",
  NO_VALID_DATE: "NO_VALID_DATE",
};

const ERROR_CODES_META = {
  [ERROR_CODES.WRONG_TX_USAGE]: {
    message: "Usage of this.tx|this.context is not allowed if parallel event processing is enabled",
  },
  [ERROR_CODES.UNKNOWN_EVENT_TYPE]: {
    message: "The event type and subType configuration is not configured! Maintain the combination in the config file.",
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
  [ERROR_CODES.MISSING_TABLE_DEFINITION]: {
    message: "Could not find table in csn. Make sure the provided table name is correct and the table is known by CDS.",
  },
  [ERROR_CODES.MISSING_ELEMENT_IN_TABLE]: {
    message: "The provided table doesn't match the required structure. At least the following element is missing.",
  },
  [ERROR_CODES.TYPE_MISMATCH_TABLE]: {
    message: "At least one field in the provided table doesn't have the expected data type.",
  },
  [ERROR_CODES.NO_VALID_DATE]: {
    message: "One or more events contain a date in a malformed format.",
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

  static missingTableInCsn(tableName) {
    const { message } = ERROR_CODES_META[ERROR_CODES.MISSING_TABLE_DEFINITION];
    return new EventQueueError(
      {
        name: ERROR_CODES.MISSING_TABLE_DEFINITION,
        info: { tableName },
      },
      message
    );
  }

  static missingElementInTable(tableName, elementName) {
    const { message } = ERROR_CODES_META[ERROR_CODES.MISSING_ELEMENT_IN_TABLE];
    return new EventQueueError(
      {
        name: ERROR_CODES.MISSING_ELEMENT_IN_TABLE,
        info: { tableName, elementName },
      },
      message
    );
  }

  static typeMismatchInTable(tableName, elementName) {
    const { message } = ERROR_CODES_META[ERROR_CODES.TYPE_MISMATCH_TABLE];
    return new EventQueueError(
      {
        name: ERROR_CODES.TYPE_MISMATCH_TABLE,
        info: { tableName, elementName },
      },
      message
    );
  }

  static malformedDate(date) {
    const { message } = ERROR_CODES_META[ERROR_CODES.NO_VALID_DATE];
    return new EventQueueError(
      {
        name: ERROR_CODES.NO_VALID_DATE,
        info: { date },
      },
      message
    );
  }
}

module.exports = EventQueueError;
