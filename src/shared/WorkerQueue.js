"use strict";

const cds = require("@sap/cds");

const config = require("../config");
const EventQueueError = require("../EventQueueError");
const { Priorities } = require("../constants");
const SetIntervalDriftSafe = require("./SetIntervalDriftSafe");

const PRIORITIES = Object.values(Priorities).reverse();
const PRIORITY_MULTIPLICATOR = PRIORITIES.reduce((result, element, index) => {
  result[element] = index + 1;
  return result;
}, {});

const COMPONENT_NAME = "/eventQueue/WorkerQueue";
const NANO_TO_MS = 1e6;
const MIN_TO_MS = 60 * 1000;
const INCREASE_PRIORITY_AFTER = 3;

let lastLogTs;

const THRESHOLD = {
  INFO: 35 * 1000,
  WARN: 55 * 1000,
  ERROR: 75 * 1000,
};

const CHECK_INTERVAL_QUEUE = 60 * 1000;

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
    this.#queue = PRIORITIES.reduce((result, priority) => {
      result[priority] = [];
      return result;
    }, {});

    const runner = new SetIntervalDriftSafe(CHECK_INTERVAL_QUEUE);
    runner.run(this.#adjustPriority.bind(this));
  }

  addToQueue(load, label, priority = Priorities.Medium, cb) {
    if (load > this.#concurrencyLimit) {
      throw EventQueueError.loadHigherThanLimit(load, label);
    }

    if (!PRIORITIES.includes(priority)) {
      throw EventQueueError.priorityNotAllowed(priority, label);
    }

    const startTime = process.hrtime.bigint();
    const p = new Promise((resolve, reject) => {
      this.#queue[priority].push([load, label, cb, resolve, reject, startTime]);
    });
    this.#checkForNext();
    return p;
  }

  #adjustPriority() {
    const checkTime = process.hrtime.bigint();
    const priorityValues = Object.values(Priorities);

    for (let i = 0; i < priorityValues.length - 1; i++) {
      const priority = priorityValues[i];
      const nextPriority = priorityValues[i + 1];
      for (let i = 0; i < this.queue[priority].length; i++) {
        const queueEntry = this.queue[priority][i];
        const startTime = queueEntry[6] ?? queueEntry[5];
        if (Math.round(Number(checkTime - startTime) / NANO_TO_MS) > INCREASE_PRIORITY_AFTER * MIN_TO_MS) {
          const [entry] = this.queue[priority].splice(i, 1);
          entry.push(checkTime);
          this.queue[nextPriority].push(entry);
        }
      }
    }
  }

  _executeFunction(load, label, cb, resolve, reject, startTime, priority) {
    this.#checkAndLogWaitingTime(startTime, label, priority);
    const promise = Promise.resolve().then(() => cb());
    this.#runningPromises.push(promise);
    this.#runningLoad = this.#runningLoad + load;
    promise
      .finally(() => {
        this.#runningLoad = this.#runningLoad - load;
        this.#runningPromises.splice(this.#runningPromises.indexOf(promise), 1);
        this.#checkForNext();
      })
      .then((...results) => {
        resolve(...results);
      })
      .catch((err) => {
        cds.log(COMPONENT_NAME).error("Error happened in WorkQueue. Errors should be caught before!", err, { label });
        reject(err);
      });

    if (this.#runningLoad !== this.#concurrencyLimit) {
      this.#checkForNext();
    }
  }

  #checkForNext() {
    if (!this.#queue.length && this.#runningLoad === this.#concurrencyLimit) {
      return;
    }

    let entryFound = false;
    for (const priority of PRIORITIES) {
      for (let i = 0; i < this.#queue[priority].length; i++) {
        const [load] = this.#queue[priority][i];
        if (this.#runningLoad + load <= this.#concurrencyLimit) {
          const [args] = this.#queue[priority].splice(i, 1);
          this._executeFunction(...args, priority);
          entryFound = true;
          break;
        }
      }
      if (entryFound) {
        break;
      }
    }
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

  get queue() {
    return this.#queue;
  }

  #checkAndLogWaitingTime(startTime, label, priority) {
    const ts = Date.now();
    if (ts - lastLogTs <= 1000) {
      return;
    }
    lastLogTs = ts;
    const diffMs = Math.round(Number(process.hrtime.bigint() - startTime) / NANO_TO_MS);
    const priorityMultiplication = PRIORITY_MULTIPLICATOR[priority];
    let logLevel;
    if (diffMs >= THRESHOLD.ERROR * priorityMultiplication) {
      logLevel = "error";
    } else if (diffMs >= THRESHOLD.WARN * priorityMultiplication) {
      logLevel = "warn";
    } else if (diffMs >= THRESHOLD.INFO * priorityMultiplication) {
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
