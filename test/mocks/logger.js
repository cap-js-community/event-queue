"use strict";

const cds = require("@sap/cds");

const LOG_LEVELS = ["debug", "info", "warn", "error", "log"];

const logger = LOG_LEVELS.reduce((result, logLevel) => {
  result[logLevel] = jest.fn();
  return result;
}, {});

const Logger = () => {
  jest.spyOn(cds, "log").mockReturnValue(logger);
  Object.defineProperty(cds, "debug", {
    get: () => jest.fn(),
  });
  return logger;
};

logger.callsLengths = () =>
  LOG_LEVELS.reduce((result, logLevel) => {
    result[logLevel] = logger[logLevel].mock.calls.length;
    return result;
  }, {});

logger.calls = () =>
  LOG_LEVELS.reduce((result, logLevel) => {
    result[logLevel] = logger[logLevel].mock.calls;
    return result;
  }, {});

logger.clearCalls = () => {
  LOG_LEVELS.forEach((level) => logger[level].mockClear());
};

const performanceTracer = {
  start: jest.fn(),
  end: jest.fn(),
};

logger.startPerformanceTrace = (...args) => {
  performanceTracer.start(args);
  return { endPerformanceTrace: performanceTracer.end };
};

logger.performanceTracer = performanceTracer;

module.exports = {
  Logger,
};
