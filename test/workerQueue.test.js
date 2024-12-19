"use strict";

const { promisify } = require("util");

const WorkerQueue = require("../src/shared/WorkerQueue");
const { Priorities } = require("../src/constants");

describe("workerQueue", () => {
  it("straight forward - limit one and one function", async () => {
    const workerQueue = new WorkerQueue(1);
    const jestFn = jest.fn();
    await workerQueue.addToQueue(1, "label", Priorities.Medium, jestFn);
    expect(jestFn).toHaveBeenCalledTimes(1);
    expect(workerQueue.runningPromises).toHaveLength(0);
  });

  it("straight forward - load higher than limit", async () => {
    const workerQueue = new WorkerQueue(1);
    const jestFn = jest.fn();

    expect(() => {
      workerQueue.addToQueue(2, "label", Priorities.Medium, jestFn);
    }).toThrowErrorMatchingInlineSnapshot(
      `"The defined load of an event is higher than the maximum defined limit. Check your configuration!"`
    );
    expect(jestFn).toHaveBeenCalledTimes(0);
    expect(workerQueue.runningPromises).toHaveLength(0);
  });

  it("straight forward - not allowed priority", async () => {
    const workerQueue = new WorkerQueue(1);
    const jestFn = jest.fn();

    expect(() => {
      workerQueue.addToQueue(1, "label", "SUPER_HIGH", jestFn);
    }).toThrowErrorMatchingInlineSnapshot(`"The supplied priority is not allowed. Only LOW, MEDIUM, HIGH is allowed!"`);
    expect(jestFn).toHaveBeenCalledTimes(0);
    expect(workerQueue.runningPromises).toHaveLength(0);
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
    const p1 = workerQueue.addToQueue(1, "label", Priorities.Medium, fn);
    const p2 = workerQueue.addToQueue(1, "label", Priorities.Medium, fn1);

    // NOTE: get the work queue the chance to start working
    await promisify(setImmediate)();

    expect(result.fn.called).toBeTruthy();
    expect(result.fn.done).toBeFalsy();
    expect(result.fn1).toBeFalsy();
    expect(workerQueue.runningPromises).toHaveLength(1);

    await Promise.allSettled([p1, p2]);

    expect(result.fn.called).toBeTruthy();
    expect(result.fn.done).toBeTruthy();
    expect(result.fn1.called).toBeTruthy();
    expect(result.fn1.done).toBeTruthy();
    expect(workerQueue.runningPromises).toHaveLength(0);
  });

  it("straight forward - consider load", async () => {
    const workerQueue = new WorkerQueue(4);
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
    const p1 = workerQueue.addToQueue(3, "label", Priorities.Medium, fn);
    const p2 = workerQueue.addToQueue(2, "label", Priorities.Medium, fn1);

    // NOTE: get the work queue the chance to start working
    await promisify(setImmediate)();

    expect(result.fn.called).toBeTruthy();
    expect(result.fn.done).toBeFalsy();
    expect(result.fn1).toBeFalsy();
    expect(workerQueue.runningPromises).toHaveLength(1);

    await Promise.allSettled([p1, p2]);

    expect(result.fn.called).toBeTruthy();
    expect(result.fn.done).toBeTruthy();
    expect(result.fn1.called).toBeTruthy();
    expect(result.fn1.done).toBeTruthy();
    expect(workerQueue.runningPromises).toHaveLength(0);
  });

  it("3 items - should process different item if next item in huge doesn't fit", async () => {
    const workerQueue = new WorkerQueue(4);

    let resolve1, resolve2, resolve3;
    const fn = async () => new Promise((resolve) => (resolve1 = resolve));
    const fn1 = async () => new Promise((resolve) => (resolve2 = resolve));
    const fn2 = async () => new Promise((resolve) => (resolve3 = resolve));
    const p1 = workerQueue.addToQueue(3, "label", Priorities.Medium, fn);
    const p2 = workerQueue.addToQueue(2, "label", Priorities.Medium, fn1);
    const p3 = workerQueue.addToQueue(1, "label", Priorities.Medium, fn2);

    expect(workerQueue.runningPromises).toHaveLength(2);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(1);
    expect(workerQueue.queue[Priorities.Medium][0][0]).toEqual(2);

    // still not enough free load after p3 is finished
    await promisify(setImmediate)();

    resolve3();
    await p3;

    expect(workerQueue.runningPromises).toHaveLength(1);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(1);
    expect(workerQueue.queue[Priorities.Medium][0][0]).toEqual(2);

    // resolve p1 to have enough free load for p2
    resolve1();
    await p1;
    await promisify(setImmediate)();

    resolve2();
    await p2;

    expect(workerQueue.runningPromises).toHaveLength(0);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(0);
  });

  it("3 items - high should be processed before medium", async () => {
    const workerQueue = new WorkerQueue(4);

    let resolve1, resolve2, resolve3;
    const fn = async () => new Promise((resolve) => (resolve1 = resolve));
    const fn1 = async () => new Promise((resolve) => (resolve2 = resolve));
    const fn2 = async () => new Promise((resolve) => (resolve3 = resolve));
    const p1 = workerQueue.addToQueue(4, "label", Priorities.Low, fn);
    const p2 = workerQueue.addToQueue(3, "label", Priorities.Medium, fn1);
    const p3 = workerQueue.addToQueue(2, "label", Priorities.High, fn2);

    expect(workerQueue.runningPromises).toHaveLength(1);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(1);
    expect(workerQueue.queue[Priorities.High]).toHaveLength(1);

    await promisify(setImmediate)();

    resolve1();
    await p1;

    expect(workerQueue.runningPromises).toHaveLength(1);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(1);
    expect(workerQueue.queue[Priorities.Medium][0][0]).toEqual(3);

    resolve3();
    await p3;
    await promisify(setImmediate)();

    expect(workerQueue.runningPromises).toHaveLength(1);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(0);

    resolve2();
    await p2;
    await promisify(setImmediate)();

    expect(workerQueue.runningPromises).toHaveLength(0);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(0);
  });

  it("4 items - very high should be processed before high and medium", async () => {
    const workerQueue = new WorkerQueue(4);

    let resolve1, resolve2, resolve3, resolve4;
    const fn = async () => new Promise((resolve) => (resolve1 = resolve));
    const fn1 = async () => new Promise((resolve) => (resolve2 = resolve));
    const fn2 = async () => new Promise((resolve) => (resolve3 = resolve));
    const fn3 = async () => new Promise((resolve) => (resolve4 = resolve));
    const p1 = workerQueue.addToQueue(4, "label", Priorities.Low, fn);
    const p2 = workerQueue.addToQueue(3, "label", Priorities.Medium, fn1);
    const p3 = workerQueue.addToQueue(1, "label", Priorities.High, fn2);
    const p4 = workerQueue.addToQueue(1, "label", Priorities.VeryHigh, fn3);

    expect(workerQueue.runningPromises).toHaveLength(1);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(1);
    expect(workerQueue.queue[Priorities.High]).toHaveLength(1);
    expect(workerQueue.queue[Priorities.VeryHigh]).toHaveLength(1);

    await promisify(setImmediate)();

    resolve1();
    await p1;

    await promisify(setImmediate)();

    expect(workerQueue.runningPromises).toHaveLength(2);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(1);
    expect(workerQueue.queue[Priorities.High]).toHaveLength(0);
    expect(workerQueue.queue[Priorities.VeryHigh]).toHaveLength(0);

    resolve3();
    resolve4();
    await p3;
    await p4;
    await promisify(setImmediate)();

    expect(workerQueue.runningPromises).toHaveLength(1);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(0);

    resolve2();
    await p2;
    await promisify(setImmediate)();

    expect(workerQueue.runningPromises).toHaveLength(0);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(0);
  });

  it("3 items - low should be shifted to medium after interval", async () => {
    jest.useFakeTimers();
    const workerQueue = new WorkerQueue(4);

    let resolve1, resolve2, resolve3;
    const fn = async () => new Promise((resolve) => (resolve1 = resolve));
    const fn1 = async () => new Promise((resolve) => (resolve2 = resolve));
    const fn2 = async () => new Promise((resolve) => (resolve3 = resolve));
    const p1 = workerQueue.addToQueue(4, "label", Priorities.Low, fn);
    const p2 = workerQueue.addToQueue(3, "label", Priorities.Medium, fn1);
    const p3 = workerQueue.addToQueue(2, "label", Priorities.High, fn2);

    expect(workerQueue.runningPromises).toHaveLength(1);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(1);
    expect(workerQueue.queue[Priorities.High]).toHaveLength(1);

    jest.spyOn(process.hrtime, "bigint").mockReturnValueOnce(3n * 61n * 1000000000n);
    jest.advanceTimersByTime(61 * 1000);
    jest.useRealTimers();

    await promisify(setImmediate)();

    expect(workerQueue.runningPromises).toHaveLength(1);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(0);
    expect(workerQueue.queue[Priorities.High]).toHaveLength(1);
    expect(workerQueue.queue[Priorities.VeryHigh]).toHaveLength(1);
    expect(workerQueue.queue[Priorities.High][0]).toEqual([
      3,
      "label",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      0n,
      183000000000n,
    ]);

    resolve1();
    await p1;

    expect(workerQueue.runningPromises).toHaveLength(1);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(0);
    expect(workerQueue.queue[Priorities.High]).toHaveLength(1);
    expect(workerQueue.queue[Priorities.VeryHigh]).toHaveLength(0);

    resolve3();
    await p3;
    await promisify(setImmediate)();

    expect(workerQueue.runningPromises).toHaveLength(1);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(0);
    expect(workerQueue.queue[Priorities.High]).toHaveLength(0);
    expect(workerQueue.queue[Priorities.VeryHigh]).toHaveLength(0);

    resolve2();
    await p2;
    await promisify(setImmediate)();

    expect(workerQueue.runningPromises).toHaveLength(0);
    expect(workerQueue.queue[Priorities.Medium]).toHaveLength(0);
    expect(workerQueue.queue[Priorities.High]).toHaveLength(0);
    expect(workerQueue.queue[Priorities.VeryHigh]).toHaveLength(0);
  });

  it("rejecting promises should not block the queue", async () => {
    cds.context = { id: "123" };
    const workerQueue = new WorkerQueue(1);
    const result = {};
    jest.spyOn(cds, "log").mockReturnValueOnce({
      info: jest.fn(),
      error: jest.fn(),
    });
    const fn = jest.fn().mockImplementation(() => {
      return new Promise((resolve, reject) => {
        result["fn"] = { called: true, done: false };
        setTimeout(() => {
          result["fn"].done = true;
          reject(new Error());
        }, 100);
      });
    });
    const fn1 = () => {
      result["fn1"] = { called: true, done: true };
    };
    const p1 = workerQueue.addToQueue(1, "label", Priorities.Medium, fn);
    const p2 = workerQueue.addToQueue(1, "label", Priorities.Medium, fn1);
    await promisify(setImmediate)();

    // NOTE: get the work queue the chance to start working
    expect(result.fn.called).toBeTruthy();
    expect(result.fn.done).toBeFalsy();
    expect(result.fn1).toBeFalsy();
    expect(workerQueue.runningPromises).toHaveLength(1);

    await Promise.allSettled([p1, p2]);

    expect(result.fn.called).toBeTruthy();
    expect(result.fn.done).toBeTruthy();
    expect(result.fn1.called).toBeTruthy();
    expect(result.fn1.done).toBeTruthy();

    expect(workerQueue.runningPromises).toHaveLength(0);
  });
});
