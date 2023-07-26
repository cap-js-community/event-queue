"use strict";

const CUSTOM_FIELD_EXECUTION_TIME = "response_time_ms";
const CUSTOM_FIELD_QUANTITY = "quantity";

class PerformanceTracer {
  /**
   * The constructor of the performance tracer
   * @param {Object} logger logger
   * @param {string} name name of the performance trace
   * @param {Object} options An options object with additional properties (optional)
   * @param {string} options.level The level to be used for logging
   * @param {string} options.summary The summary to be used for logging
   * @param {Object} options.startMessage Writes a log record with the provided details when starting the action
   */
  constructor(logger, name, options = {}) {
    this.__start = new Date();
    this.__logger = logger;
    this.__name = name;
    options.startMessage &&
      logger.info("Performance measurement started", {
        name: name,
        ...options.startMessage,
      });
  }

  /**
   * Ends the performance trace
   * @param {Object} options An options object with additional properties (optional)
   * @param {Number} options.quantity A case-specific quantity such as a node count that influences the execution time (optional)
   * @param {Number} options.threshold Only write the log above verbose level, if threshold in ms. is met (optional)
   * @param {Number} options.additionalQuantityThreshold Value multiplied with quantity and added to the threshold (optional)
   */
  endPerformanceTrace(...args) {
    let options = {};
    //determine, if an options object was provided as first argument
    if (
      typeof args?.[0] === "object" &&
      (args[0].quantity >= 0 || args[0].threshold > 0 || args[0].additionalQuantityThreshold > 0)
    ) {
      options = args.shift();
    }
    const currentTime = new Date();
    const executionTime = currentTime - this.__start;
    this.__start = currentTime;
    const isBelowThreshold =
      options &&
      options.threshold &&
      executionTime <
        options.threshold +
          (options.additionalQuantityThreshold > 0 && options.quantity > 0
            ? options.additionalQuantityThreshold * options.quantity
            : 0);

    if (isBelowThreshold) {
      return;
    }

    const customFields = {
      [CUSTOM_FIELD_EXECUTION_TIME]: executionTime,
      [CUSTOM_FIELD_QUANTITY]: options.quantity,
    };

    this.__logger.info("Performance measurement executed", {
      name: this.__name,
      milliseconds: executionTime,
      customFields,
    });
  }
}

module.exports = PerformanceTracer;
