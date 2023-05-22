"use strict";

const cds = require("@sap/cds");

const { Logger } = require("./logger");
const { getConfigInstance } = require("../config");

const COMPONENT_NAME = "eventQueue/WorkerQueue";

let instance = null;

class WorkerQueue {
  constructor(concurrency) {
    if (Number.isNaN(concurrency) || concurrency <= 0) {
      this.__concurrencyLimit = 1;
    } else {
      this.__concurrencyLimit = concurrency;
    }
    this.__runningPromises = [];
    this.__queue = [];
  }

  addToQueue(cb) {
    if (this.__runningPromises.length >= this.__concurrencyLimit) {
      this.__queue.push(cb);
    } else {
      this._executeFunction(cb);
    }
  }

  _executeFunction(cb) {
    const promise =
      cb.constructor.name === "AsyncFunction" ? cb() : Promise.resolve(cb());
    this.__runningPromises.push(promise);
    promise
      .catch((err) => {
        Logger(cds.context, COMPONENT_NAME).error(
          "Error happened in WorkQueue. Errors should be caught before!",
          {
            error: err,
          }
        );
      })
      .finally(() => {
        this.__runningPromises.splice(
          this.__runningPromises.indexOf(promise),
          1
        );
        this._checkForNext();
      });
  }

  _checkForNext() {
    if (
      !this.__queue.length ||
      this.__runningPromises.length >= this.__concurrencyLimit
    ) {
      return;
    }
    const cb = this.__queue.shift();
    this._executeFunction(cb);
  }
}

module.exports = {
  getWorkerPoolInstance: () => {
    if (!instance) {
      const configInstance = getConfigInstance();
      instance = new WorkerQueue(configInstance.parallelTenantProcessing);
    }
    return instance;
  },
  _: {
    WorkerQueue,
  },
};
