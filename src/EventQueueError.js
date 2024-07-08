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
  INVALID_INTERVAL: "INVALID_INTERVAL",
  MISSING_IMPL: "MISSING_IMPL",
  DUPLICATE_EVENT_REGISTRATION: "DUPLICATE_EVENT_REGISTRATION",
  NO_MANUEL_INSERT_OF_PERIODIC: "NO_MANUEL_INSERT_OF_PERIODIC",
  LOAD_HIGHER_THAN_LIMIT: "LOAD_HIGHER_THAN_LIMIT",
  NOT_ALLOWED_PRIORITY: "NOT_ALLOWED_PRIORITY",
  APP_NAMES_FORMAT: "APP_NAMES_FORMAT",
  SCHEMA_TENANT_MISMATCH: "SCHEMA_TENANT_MISMATCH",
  GLOBAL_CDS_CONTEXT_MISMATCH: "GLOBAL_CDS_CONTEXT_MISMATCH",
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
  [ERROR_CODES.INVALID_INTERVAL]: {
    message: "Invalid interval, the value needs to greater than 10 seconds.",
  },
  [ERROR_CODES.MISSING_IMPL]: {
    message: "Missing path to event class implementation.",
  },
  [ERROR_CODES.DUPLICATE_EVENT_REGISTRATION]: {
    message: "Duplicate event registration, check the uniqueness of type and subType.",
  },
  [ERROR_CODES.NO_MANUEL_INSERT_OF_PERIODIC]: {
    message: "Periodic events are managed by the framework and are not allowed to insert manually.",
  },
  [ERROR_CODES.LOAD_HIGHER_THAN_LIMIT]: {
    message: "The defined load of an event is higher than the maximum defined limit. Check your configuration!",
  },
  [ERROR_CODES.NOT_ALLOWED_PRIORITY]: {
    message: "The supplied priority is not allowed. Only LOW, MEDIUM, HIGH is allowed!",
  },
  [ERROR_CODES.APP_NAMES_FORMAT]: {
    message: "The app names property must be an array and only contain strings.",
  },
  [ERROR_CODES.SCHEMA_TENANT_MISMATCH]: {
    message: "The db client associated to the tenant context does not match! Processing will be skipped.",
  },
  [ERROR_CODES.GLOBAL_CDS_CONTEXT_MISMATCH]: {
    message: "The global cds context does not match the local cds context.",
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

  static invalidInterval(type, subType, interval) {
    const { message } = ERROR_CODES_META[ERROR_CODES.INVALID_INTERVAL];
    return new EventQueueError(
      {
        name: ERROR_CODES.INVALID_INTERVAL,
        info: { type, subType, interval },
      },
      message
    );
  }

  static missingImpl(type, subType) {
    const { message } = ERROR_CODES_META[ERROR_CODES.MISSING_IMPL];
    return new EventQueueError(
      {
        name: ERROR_CODES.MISSING_IMPL,
        info: { type, subType },
      },
      message
    );
  }

  static duplicateEventRegistration(type, subType) {
    const { message } = ERROR_CODES_META[ERROR_CODES.DUPLICATE_EVENT_REGISTRATION];
    return new EventQueueError(
      {
        name: ERROR_CODES.DUPLICATE_EVENT_REGISTRATION,
        info: { type, subType },
      },
      message
    );
  }

  static manuelPeriodicEventInsert(type, subType) {
    const { message } = ERROR_CODES_META[ERROR_CODES.NO_MANUEL_INSERT_OF_PERIODIC];
    return new EventQueueError(
      {
        name: ERROR_CODES.NO_MANUEL_INSERT_OF_PERIODIC,
        info: { type, subType },
      },
      message
    );
  }
  static loadHigherThanLimit(load, label) {
    const { message } = ERROR_CODES_META[ERROR_CODES.LOAD_HIGHER_THAN_LIMIT];
    return new EventQueueError(
      {
        name: ERROR_CODES.LOAD_HIGHER_THAN_LIMIT,
        info: { load, label },
      },
      message
    );
  }

  static priorityNotAllowed(priority, label) {
    const { message } = ERROR_CODES_META[ERROR_CODES.NOT_ALLOWED_PRIORITY];
    return new EventQueueError(
      {
        name: ERROR_CODES.NOT_ALLOWED_PRIORITY,
        info: { priority, label },
      },
      message
    );
  }

  static appNamesFormat(type, subType, appNames) {
    const { message } = ERROR_CODES_META[ERROR_CODES.APP_NAMES_FORMAT];
    return new EventQueueError(
      {
        name: ERROR_CODES.APP_NAMES_FORMAT,
        info: { type, subType, appNames },
      },
      message
    );
  }

  static dbClientSchemaMismatch(tenantId, dbClientSchema, serviceManagerSchema) {
    const { message } = ERROR_CODES_META[ERROR_CODES.SCHEMA_TENANT_MISMATCH];
    return new EventQueueError(
      {
        name: ERROR_CODES.SCHEMA_TENANT_MISMATCH,
        info: { tenantId, dbClientSchema, serviceManagerSchema },
      },
      message
    );
  }

  static globalCdsContextNotMatchingLocal(globalProperties, localProperties) {
    const { message } = ERROR_CODES_META[ERROR_CODES.GLOBAL_CDS_CONTEXT_MISMATCH];
    return new EventQueueError(
      {
        name: ERROR_CODES.GLOBAL_CDS_CONTEXT_MISMATCH,
        info: { globalProperties, localProperties },
      },
      message
    );
  }
}

module.exports = EventQueueError;
