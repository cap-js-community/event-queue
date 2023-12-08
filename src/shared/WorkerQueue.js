"use strict";

const cds = require("@sap/cds");

const config = require("../config");
const EventQueueError = require("../EventQueueError");

const COMPONENT_NAME = "eventQueue/WorkerQueue";
const NANO_TO_MS = 1e6;
const THRESHOLD = {
  INFO: 35 * 1000,
  WARN: 55 * 1000,
  ERROR: 75 * 1000,
};

class WorkerQueue {
  #concurrencyLimit;
  #runningPromises;
  #runningLoad;
  #queue;
  static #instance;

  constructor(concurrency) {
    if (Number.isNaN(concurrency) || concurrency <= 0) {
      this.#concurrencyLimit = 1;
    } else {
      this.#concurrencyLimit = concurrency;
    }
    this.#runningPromises = [];
    this.#runningLoad = 0;
    this.#queue = [];
  }

  addToQueue(load, label, cb) {
    if (load > this.#concurrencyLimit) {
      throw EventQueueError.loadHigherThanLimit(load, label);
    }

    const startTime = process.hrtime.bigint();
    const p = new Promise((resolve, reject) => {
      this.#queue.push([load, label, cb, resolve, reject, startTime]);
    });
    this._checkForNext();
    return p;
  }

  _executeFunction(load, label, cb, resolve, reject, startTime) {
    this.checkAndLogWaitingTime(startTime, label);
    const promise = Promise.resolve().then(() => cb());
    this.#runningPromises.push(promise);
    this.#runningLoad = this.#runningLoad + load;
    promise
      .finally(() => {
        this.#runningLoad = this.#runningLoad - load;
        this.#runningPromises.splice(this.#runningPromises.indexOf(promise), 1);
        this._checkForNext();
      })
      .then((...results) => {
        resolve(...results);
      })
      .catch((err) => {
        cds.log(COMPONENT_NAME).error("Error happened in WorkQueue. Errors should be caught before!", err, { label });
        reject(err);
      });
  }

  _checkForNext() {
    const load = this.#queue[0]?.[0];
    if (!this.#queue.length || this.#runningLoad + load > this.#concurrencyLimit) {
      return;
    }
    const args = this.#queue.shift();
    this._executeFunction(...args);
  }

  get runningPromises() {
    return this.#runningPromises;
  }

  /**
   @return { WorkerQueue }
   **/
  static get instance() {
    if (!WorkerQueue.#instance) {
      WorkerQueue.#instance = new WorkerQueue(config.instanceLoadLimit);
    }
    return WorkerQueue.#instance;
  }

  checkAndLogWaitingTime(startTime, label) {
    const diffMs = Math.round(Number(process.hrtime.bigint() - startTime) / NANO_TO_MS);
    let logLevel;
    if (diffMs >= THRESHOLD.ERROR) {
      logLevel = "error";
    } else if (diffMs >= THRESHOLD.WARN) {
      logLevel = "warn";
    } else if (diffMs >= THRESHOLD.INFO) {
      logLevel = "info";
    } else {
      logLevel = "debug";
    }
    cds.log(COMPONENT_NAME)[logLevel]("Waiting time in worker queue", {
      diffMs,
      label,
    });
  }
}

module.exports = WorkerQueue;
