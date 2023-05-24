"use strict";

const cds = require("@sap/cds");

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
    const p = new Promise((resolve, reject) => {
      this.__queue.push([cb, resolve, reject]);
    });
    this._checkForNext();
    return p;
  }

  _executeFunction(cb, resolve, reject) {
    const promise = Promise.resolve().then(() => cb());
    this.__runningPromises.push(promise);
    promise
      .finally(() => {
        this.__runningPromises.splice(
          this.__runningPromises.indexOf(promise),
          1
        );
        this._checkForNext();
      })
      .then((...results) => {
        resolve(...results);
      })
      .catch((err) => {
        cds
          .log(COMPONENT_NAME)
          .error(
            "Error happened in WorkQueue. Errors should be caught before!",
            {
              error: err,
            }
          );
        reject(err);
      });
  }

  _checkForNext() {
    if (
      !this.__queue.length ||
      this.__runningPromises.length >= this.__concurrencyLimit
    ) {
      return;
    }
    const [cb, resolve, reject] = this.__queue.shift();
    this._executeFunction(cb, resolve, reject);
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
