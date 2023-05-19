"use strict";

const util = require("util");
const VError = require("verror");
const PerformanceTracer = require("./PerformanceTracer");

let loggerInitialized = false;
const STATIC_LOG_PROPERTIES = {
  component_type: "application",
  component_name: "",
  component_instance: "",
  organization_name: "",
  organization_id: "",
  space_name: "",
  space_id: "",
  type: "log",
};

const LOG_LEVELS = {
  DEBUG: "debug",
  VERBOSE: "verbose",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
};

const LOGS_BY_LEVEL = {
  DEBUG: Object.values(LOG_LEVELS),
  VERBOSE: [
    LOG_LEVELS.VERBOSE,
    LOG_LEVELS.INFO,
    LOG_LEVELS.WARN,
    LOG_LEVELS.ERROR,
  ],
  INFO: [LOG_LEVELS.INFO, LOG_LEVELS.WARN, LOG_LEVELS.ERROR],
  WARN: [LOG_LEVELS.WARN, LOG_LEVELS.ERROR],
  ERROR: [LOG_LEVELS.ERROR],
};

const _loadStaticLogProperties = () => {
  const vcapEnv = JSON.parse(process.env.VCAP_APPLICATION ?? "{}");
  STATIC_LOG_PROPERTIES.component_name = vcapEnv.application_name;
  STATIC_LOG_PROPERTIES.component_instance = vcapEnv.instance_index;
  STATIC_LOG_PROPERTIES.organization_id = vcapEnv.organization_id;
  STATIC_LOG_PROPERTIES.organization_name = vcapEnv.organization_name;
  STATIC_LOG_PROPERTIES.space_name = vcapEnv.space_name;
  STATIC_LOG_PROPERTIES.space_id = vcapEnv.space_id;
};

const Logger = (
  context,
  layer,
  {
    correlationIdLogger = context.id,
    logLevel = LOG_LEVELS.INFO,
    subdomain,
  } = {}
) => {
  !loggerInitialized && _loadStaticLogProperties();
  const combineProperties = (
    level,
    message,
    { correlationId, date, customFields, additionalMessageProperties, error }
  ) => {
    if (message instanceof VError) {
      message = util.formatWithOptions(
        { colors: false },
        "%s: \n%s: %O",
        VError.fullStack(message),
        "vErrorInfos",
        VError.info(message)
      );
    }
    return {
      ...STATIC_LOG_PROPERTIES,
      level,
      layer,
      msg:
        message +
        (additionalMessageProperties
          ? "\n" +
            util.formatWithOptions(
              { colors: false },
              "%O",
              additionalMessageProperties
            )
          : "") +
        (error
          ? "\n" + util.formatWithOptions({ colors: false }, "%O", error)
          : ""),
      written_at: date ?? new Date().toISOString(),
      correlation_id: correlationId ?? correlationIdLogger,
      tenant_id: context?.tenant,
      tenant_subdomain:
        subdomain ?? context?.http?.req?.authInfo?.getSubdomain?.(),
      ...customFields,
    };
  };
  const logger = {
    setLogLevel: (newLogLevel) => (logLevel = newLogLevel),
    ...Object.keys(LOG_LEVELS).reduce((result, functionLogLevel) => {
      result[[LOG_LEVELS[functionLogLevel]]] = (
        message,
        {
          correlationId,
          date,
          customFields,
          additionalMessageProperties,
          error,
        } = {}
      ) => {
        if (
          LOGS_BY_LEVEL[logLevel.toUpperCase()].includes(
            functionLogLevel.toLowerCase()
          )
        ) {
          _log(
            combineProperties(LOG_LEVELS[functionLogLevel], message, {
              correlationId,
              date,
              customFields,
              additionalMessageProperties,
              error,
            })
          );
        }
      };
      return result;
    }, {}),
  };
  logger.startPerformanceTrace = (name, options = {}) => {
    return new PerformanceTracer(logger, name, options);
  };

  return logger;
};

const _log = (options) => {
  process.stdout.write(JSON.stringify(options) + "\n");
};

module.exports = {
  Logger,
};
