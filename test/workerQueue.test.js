"use strict";

const { promisify } = require("util");

const {
  _: { WorkerQueue },
} = require("../src/shared/WorkerQueue");

describe("workerQueue", () => {
  it("straight forward - limit one and one function", async () => {
    const workerQueue = new WorkerQueue(1);
    const jestFn = jest.fn();
    workerQueue.addToQueue(jestFn);
    expect(jestFn).toHaveBeenCalledTimes(1);
    await promisify(setTimeout)(100);
    expect(workerQueue.__runningPromises).toHaveLength(0);
  });

  it("straight forward - limit one and two promises", async () => {
    const workerQueue = new WorkerQueue(1);
    const result = {};
    const fn = jest.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        result["fn"] = { called: true, done: false };
        setTimeout(() => {
          result["fn"].done = true;
          resolve();
        }, 100);
      });
    });
    const fn1 = () => {
      result["fn1"] = { called: true, done: true };
    };
    workerQueue.addToQueue(fn);
    workerQueue.addToQueue(fn1);
    expect(result.fn.called).toBeTruthy();
    expect(result.fn.done).toBeFalsy();
    expect(result.fn1).toBeFalsy();
    expect(workerQueue.__runningPromises).toHaveLength(1);

    jest.runAllTimers();

    // process node event queue
    await promisify(setTimeout)(100);
    expect(result.fn.called).toBeTruthy();
    expect(result.fn.done).toBeTruthy();
    expect(result.fn1.called).toBeTruthy();
    expect(result.fn1.done).toBeTruthy();
    expect(workerQueue.__runningPromises).toHaveLength(0);
  });

  it("rejecting promises should not block the queue", async () => {
    cds.context = { id: "123" };
    const workerQueue = new WorkerQueue(1);
    const result = {};
    const fn = jest.fn().mockImplementation(() => {
      return new Promise((resolve, reject) => {
        result["fn"] = { called: true, done: false };
        setTimeout(() => {
          result["fn"].done = true;
          reject();
        }, 100);
      });
    });
    const fn1 = () => {
      result["fn1"] = { called: true, done: true };
    };
    workerQueue.addToQueue(fn);
    workerQueue.addToQueue(fn1);
    expect(result.fn.called).toBeTruthy();
    expect(result.fn.done).toBeFalsy();
    expect(result.fn1).toBeFalsy();
    expect(workerQueue.__runningPromises).toHaveLength(1);

    jest.runAllTimers();

    // process node event queue
    await promisify(setTimeout)(100);
    expect(result.fn.called).toBeTruthy();
    expect(result.fn.done).toBeTruthy();
    expect(result.fn1.called).toBeTruthy();
    expect(result.fn1.done).toBeTruthy();
    expect(workerQueue.__runningPromises).toHaveLength(0);
  });
});
