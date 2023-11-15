"use strict";

const cds = require("@sap/cds");

const config = require("../config");
const EventQueueError = require("../EventQueueError");

const COMPONENT_NAME = "eventQueue/WorkerQueue";

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

  addToQueue(load, cb) {
    if (load > this.#concurrencyLimit) {
      throw EventQueueError.loadHigherThanLimit(load);
    }

    const p = new Promise((resolve, reject) => {
      this.#queue.push([load, cb, resolve, reject]);
    });
    this._checkForNext();
    return p;
  }

  _executeFunction(load, cb, resolve, reject) {
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
        cds.log(COMPONENT_NAME).error("Error happened in WorkQueue. Errors should be caught before!", err);
        reject(err);
      });
  }

  _checkForNext() {
    const load = this.#queue[0]?.[0];
    if (!this.#queue.length || this.#runningLoad + load > this.#concurrencyLimit) {
      return;
    }
    const [, cb, resolve, reject] = this.#queue.shift();
    this._executeFunction(load, cb, resolve, reject);
  }

  get runningPromises() {
    return this.#runningPromises;
  }

  /**
   @return { WorkerQueue }
   **/
  static get instance() {
    if (!WorkerQueue.#instance) {
      WorkerQueue.#instance = new WorkerQueue(config.parallelTenantProcessing);
    }
    return WorkerQueue.#instance;
  }
}

const instance = WorkerQueue.instance;

module.exports = {
  workerQueue: instance,
  _: {
    WorkerQueue,
  },
};
