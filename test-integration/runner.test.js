"use strict";

const { promisify } = require("util");

const cds = require("@sap/cds");
cds.test(__dirname + "/_env");

const mockRedis = require("../test/mocks/redisMock");
jest.mock("../src/shared/redis", () => mockRedis);
const cdsHelper = require("../src/shared/cdsHelper");
const WorkerQueue = require("../src/shared/WorkerQueue");
const getAllTenantIdsSpy = jest.spyOn(cdsHelper, "getAllTenantIds");
jest.spyOn(cdsHelper, "getSubdomainForTenantId").mockResolvedValue("dummy");
const processEventQueue = require("../src/processEventQueue");
const { Logger: mockLogger } = require("../test/mocks/logger");

const processEventQueueSpy = jest.spyOn(processEventQueue, "processEventQueue").mockImplementation(
  async () =>
    new Promise((resolve) => {
      setTimeout(resolve, 10);
    })
);

const distributedLock = require("../src/shared/distributedLock");
const eventQueue = require("../src");
const runner = require("../src/runner");
const path = require("path");
const periodicEvents = require("../src/periodicEvents");

const tenantIds = [
  "cd805323-879c-4bf7-b19c-8ffbbee22e1f",
  "9f3ed8f0-8aaf-439e-a96a-04cd5b680c59",
  "e9bb8ec0-c85e-4035-b7cf-1b11ba8e5792",
];

describe("redisRunner", () => {
  let context, tx, configInstance, loggerMock;

  beforeAll(async () => {
    const configFilePath = path.join(__dirname, "..", "./test", "asset", "configSmall.yml");
    await eventQueue.initialize({
      configFilePath,
      processEventsAfterPublish: false,
      registerAsEventProcessor: false,
    });
    configInstance = eventQueue.config;
    configInstance.redisEnabled = true;
    loggerMock = mockLogger();
    jest.clearAllMocks();
  });

  beforeEach(async () => {
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
    await cds.tx({}, (tx2) => tx2.run(DELETE.from("sap.eventqueue.Lock")));
    await distributedLock.releaseLock({}, "EVENT_QUEUE_RUN_ID", {
      tenantScoped: false,
    });
    runner.__.clearHash();
  });

  afterEach(async () => {
    await tx?.rollback?.();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await cds.disconnect();
    await cds.shutdown();
  });

  it("redis", async () => {
    const setValueWithExpireSpy = jest.spyOn(distributedLock, "setValueWithExpire");
    const acquireLockSpy = jest.spyOn(distributedLock, "acquireLock");
    const checkLockExistsAndReturnValueSpy = jest.spyOn(distributedLock, "checkLockExistsAndReturnValue");
    getAllTenantIdsSpy
      .mockResolvedValueOnce(tenantIds)
      .mockResolvedValueOnce(tenantIds)
      .mockResolvedValueOnce(tenantIds);
    const p1 = runner.__._multiTenancyRedis();
    const p2 = runner.__._multiTenancyRedis();

    await Promise.allSettled([p1, p2]);
    await Promise.allSettled(WorkerQueue.instance.runningPromises);

    expect(setValueWithExpireSpy).toHaveBeenCalledTimes(3);
    expect(checkLockExistsAndReturnValueSpy).toHaveBeenCalledTimes(1);
    // 3 tenants * 1 acquire lock for periodic run (happens only once per instance [tenant hash] +
    // 3 tenants * 2 fn calls * 2 events (1 ad hoc and 1 periodic)
    expect(acquireLockSpy).toHaveBeenCalledTimes(15);
    // 3 tenants * 1 ad hoc and 1 periodic
    expect(processEventQueueSpy).toHaveBeenCalledTimes(6);

    const acquireLockMock = acquireLockSpy.mock;
    const tenantChecks = tenantIds.reduce((result, tenantId) => {
      result[tenantId] = { numberOfChecks: 0, values: [] };
      return result;
    }, {});
    const acquireLocksAdhocResults = [];
    const acquireLocksAdhocCalls = acquireLockMock.calls.filter((call, index) => {
      if (call[1].includes("Task")) {
        acquireLocksAdhocResults.push(acquireLockMock.results[index]);
        return true;
      }
    });
    const runId = acquireLocksAdhocCalls[0][1];
    for (let i = 0; i < 6; i++) {
      const tenantId = acquireLocksAdhocCalls[i][0].tenant;
      expect(runId).toEqual(acquireLocksAdhocCalls[i][1]);
      const result = await acquireLocksAdhocResults[i].value;
      tenantChecks[tenantId].numberOfChecks++;
      tenantChecks[tenantId].values.push(result);
    }
    expect(tenantChecks).toMatchSnapshot();

    // another run within 5 minutes should do nothing
    await runner.__._multiTenancyRedis();
    await Promise.allSettled(WorkerQueue.instance.runningPromises);
    expect(acquireLockSpy).toHaveBeenCalledTimes(21);
    expect(processEventQueueSpy).toHaveBeenCalledTimes(6);
    expect(WorkerQueue.instance.runningPromises).toHaveLength(0);
    expect(loggerMock.callsLengths().error).toEqual(0);
  });

  it("db", async () => {
    configInstance.redisEnabled = false;
    const originalCdsTx = cds.tx;
    jest.spyOn(periodicEvents, "checkAndInsertPeriodicEvents").mockResolvedValue();
    jest.spyOn(cds, "tx").mockImplementation(function (context, fn) {
      if (!fn) {
        return originalCdsTx.call(this, context);
      }
      if (fn.toString().toLowerCase().includes("await fn(tx, ...parameters)")) {
        context.tenant = null;
      }
      return originalCdsTx.call(this, context, fn);
    });
    const acquireLockSpy = jest.spyOn(distributedLock, "acquireLock");
    getAllTenantIdsSpy
      .mockResolvedValueOnce(tenantIds)
      .mockResolvedValueOnce(tenantIds)
      .mockResolvedValueOnce(tenantIds)
      .mockResolvedValueOnce(tenantIds);
    expect(processEventQueueSpy).toHaveBeenCalledTimes(0);
    const p1 = runner.__._multiTenancyDb();
    const p2 = runner.__._multiTenancyDb();
    await Promise.allSettled([p1, p2]);
    await Promise.allSettled(WorkerQueue.instance.runningPromises);

    // 3 tenants * 1 acquire lock for periodic run (happens only once per instance [tenant hash] +
    // 3 tenants * 2 fn calls * 2 events (1 ad hoc and 1 periodic)
    expect(acquireLockSpy).toHaveBeenCalledTimes(15);
    // 3 tenants * 1 ad hoc + 1 periodic
    expect(processEventQueueSpy).toHaveBeenCalledTimes(6);

    const acquireLockMock = acquireLockSpy.mock;

    const tenantChecks = tenantIds.reduce((result, tenantId) => {
      result[tenantId] = { numberOfChecks: 0, values: {} };
      return result;
    }, {});
    const acquireLocksAdhocResults = [];
    const acquireLocksAdhocCalls = acquireLockMock.calls.filter((call, index) => {
      if (call[1].includes("Task")) {
        acquireLocksAdhocResults.push(acquireLockMock.results[index]);
        return true;
      }
    });
    const runId = acquireLocksAdhocCalls[0][1];
    for (let i = 0; i < 6; i++) {
      const tenantId = acquireLocksAdhocCalls[i][0].tenant;
      expect(runId).toEqual(acquireLocksAdhocCalls[i][1]);
      const result = await acquireLocksAdhocResults[i].value;
      tenantChecks[tenantId].numberOfChecks++;
      tenantChecks[tenantId].values[result] = 1;
    }
    expect(tenantChecks).toMatchSnapshot();

    // another run within 5 minutes should do nothing
    await runner.__._multiTenancyDb();
    await Promise.allSettled(WorkerQueue.instance.runningPromises);
    expect(processEventQueueSpy).toHaveBeenCalledTimes(6);
    expect(acquireLockSpy).toHaveBeenCalledTimes(21);

    // 5 min's later the tenants should be processed again
    await cds.tx({}, (tx2) =>
      tx2.run(
        UPDATE.entity("sap.eventqueue.Lock").set({
          createdAt: new Date(Date.now() - 26 * 60 * 1000).toISOString(),
        })
      )
    );

    await runner.__._multiTenancyDb();
    await Promise.allSettled(WorkerQueue.instance.runningPromises);
    expect(WorkerQueue.instance.runningPromises).toHaveLength(0);
    expect(acquireLockSpy).toHaveBeenCalledTimes(27);
    expect(processEventQueueSpy).toHaveBeenCalledTimes(12);
    expect(loggerMock.callsLengths().error).toEqual(0);
    jest.spyOn(cds, "tx").mockRestore();
  });

  it("db - single tenant", async () => {
    configInstance.redisEnabled = false;
    const originalCdsTx = cds.tx;
    jest.spyOn(cds, "tx").mockImplementation(async function (context, fn) {
      if (!fn) {
        return originalCdsTx.call(this, context);
      }
      if (fn.toString().toLowerCase().includes("await fn(tx, ...parameters)")) {
        context.tenant = null;
      }
      return originalCdsTx.call(this, context, fn);
    });
    const acquireLockSpy = jest.spyOn(distributedLock, "acquireLock");

    await Promise.all([runner.__._singleTenantDb(), runner.__._singleTenantDb()]).then((promises) =>
      Promise.all(promises.flat())
    );

    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(processEventQueueSpy).toHaveBeenCalledTimes(2);
    expect(acquireLockSpy).toHaveBeenCalledTimes(4);
    expect(WorkerQueue.instance.runningPromises).toHaveLength(0);
  });

  describe("_calculateOffsetForFirstRun", () => {
    beforeEach(() => {
      configInstance.redisEnabled = true;
      mockRedis.clearState();
    });

    it("should have default offset with no previous run", async () => {
      const result = await runner.__._calculateOffsetForFirstRun();
      expect(result).toEqual(25 * 60 * 1000);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("acquireRunId should set ts", async () => {
      let runTs = await distributedLock.checkLockExistsAndReturnValue({}, runner.__.EVENT_QUEUE_RUN_TS, {
        tenantScoped: false,
      });
      expect(runTs).toBeNull();
      await runner.__._acquireRunId();
      runTs = await distributedLock.checkLockExistsAndReturnValue({}, runner.__.EVENT_QUEUE_RUN_TS, {
        tenantScoped: false,
      });
      expect(runTs).toBeDefined();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("should calculate correct offset", async () => {
      await runner.__._acquireRunId();
      jest.useFakeTimers();
      const systemTime = Date.now();
      jest.setSystemTime(systemTime);
      const runTs = await distributedLock.checkLockExistsAndReturnValue({}, runner.__.EVENT_QUEUE_RUN_TS, {
        tenantScoped: false,
      });
      const expectedTs = new Date(runTs).getTime() + configInstance.runInterval - systemTime;
      const result = await runner.__._calculateOffsetForFirstRun();
      expect(result).toEqual(expectedTs);
      expect(loggerMock.callsLengths().error).toEqual(0);
      jest.useRealTimers();
    });

    it("should calculate correct offset - manuel set", async () => {
      const ts = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      await distributedLock.setValueWithExpire({}, runner.__.EVENT_QUEUE_RUN_TS, ts, { tenantScoped: false });
      jest.useFakeTimers();
      const systemTime = Date.now();
      jest.setSystemTime(systemTime);
      const runTs = await distributedLock.checkLockExistsAndReturnValue({}, runner.__.EVENT_QUEUE_RUN_TS, {
        tenantScoped: false,
      });
      const expectedTs = new Date(runTs).getTime() + configInstance.runInterval - systemTime;
      const result = await runner.__._calculateOffsetForFirstRun();
      expect(result).toEqual(expectedTs);
      expect(loggerMock.callsLengths().error).toEqual(0);
      jest.useRealTimers();
    });
  });

  describe("tenant hash", () => {
    it("should trigger update periodic events once per tenant", async () => {
      let counter = 0;
      let acquireLockSpy;
      const promise = new Promise((resolve) => {
        acquireLockSpy = jest.spyOn(distributedLock, "acquireLock").mockImplementation(async (context, key) => {
          if (key === "EVENT_QUEUE_RUN_PERIODIC_EVENT") {
            counter++;
          }
          if (counter === tenantIds.length) {
            resolve();
          }
        });
      });
      getAllTenantIdsSpy.mockResolvedValueOnce(tenantIds);
      await runner.__._multiTenancyDb();
      await promise;
      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_RUN_PERIODIC_EVENT")).toHaveLength(3);

      acquireLockSpy.mockRestore();
    });

    it("should not trigger update again if tenant ids have not been changed", async () => {
      let counter = 0;
      let acquireLockSpy;
      const promise = new Promise((resolve) => {
        acquireLockSpy = jest.spyOn(distributedLock, "acquireLock").mockImplementation(async (context, key) => {
          if (key === "EVENT_QUEUE_RUN_PERIODIC_EVENT") {
            counter++;
          }
          if (counter === tenantIds.length) {
            resolve();
          }
        });
      });
      getAllTenantIdsSpy.mockResolvedValueOnce(tenantIds);
      await runner.__._multiTenancyDb();
      await promise;
      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_RUN_PERIODIC_EVENT")).toHaveLength(3);

      // second run
      getAllTenantIdsSpy.mockResolvedValueOnce(tenantIds);
      await runner.__._multiTenancyDb();
      await promisify(setTimeout)(500);

      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_RUN_PERIODIC_EVENT")).toHaveLength(3);
      acquireLockSpy.mockRestore();
    });

    it("should trigger update again if tenant ids have been changed", async () => {
      let counter = 0;
      let acquireLockSpy;
      const promise = new Promise((resolve) => {
        acquireLockSpy = jest.spyOn(distributedLock, "acquireLock").mockImplementation(async (context, key) => {
          if (key === "EVENT_QUEUE_RUN_PERIODIC_EVENT") {
            counter++;
          }
          if (counter === tenantIds.length) {
            resolve();
          }
        });
      });
      getAllTenantIdsSpy.mockResolvedValueOnce(tenantIds);
      await runner.__._multiTenancyDb();
      await promise;
      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_RUN_PERIODIC_EVENT")).toHaveLength(3);

      // second run with changed tenant ids
      getAllTenantIdsSpy.mockResolvedValueOnce(tenantIds.concat("e9bb8ec0-c85e-4035-b7cf-1b11ba8e5792"));

      const promise2 = new Promise((resolve) => {
        counter = 0;
        acquireLockSpy.mockRestore();
        acquireLockSpy = jest.spyOn(distributedLock, "acquireLock").mockImplementation(async (context, key) => {
          if (key === "EVENT_QUEUE_RUN_PERIODIC_EVENT") {
            counter++;
          }
          if (counter === tenantIds.length) {
            resolve();
          }
        });
      });

      await runner.__._multiTenancyDb();
      await promise2;

      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_RUN_PERIODIC_EVENT")).toHaveLength(4);
      acquireLockSpy.mockRestore();
    });

    it("should trigger update again if tenant ids have been changed and third run should not trigger an update", async () => {
      let counter = 0;
      let acquireLockSpy;
      const promise = new Promise((resolve) => {
        acquireLockSpy = jest.spyOn(distributedLock, "acquireLock").mockImplementation(async (context, key) => {
          if (key === "EVENT_QUEUE_RUN_PERIODIC_EVENT") {
            counter++;
          }
          if (counter === tenantIds.length) {
            resolve();
          }
        });
      });
      getAllTenantIdsSpy.mockResolvedValueOnce(tenantIds);
      await runner.__._multiTenancyDb();
      await promise;
      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_RUN_PERIODIC_EVENT")).toHaveLength(3);

      // second run with changed tenant ids
      getAllTenantIdsSpy.mockResolvedValueOnce(tenantIds.concat("e9bb8ec0-c85e-4035-b7cf-1b11ba8e5792"));

      const promise2 = new Promise((resolve) => {
        counter = 0;
        acquireLockSpy.mockRestore();
        acquireLockSpy = jest.spyOn(distributedLock, "acquireLock").mockImplementation(async (context, key) => {
          if (key === "EVENT_QUEUE_RUN_PERIODIC_EVENT") {
            counter++;
          }
          if (counter === tenantIds.length) {
            resolve();
          }
        });
      });

      await runner.__._multiTenancyDb();
      await promise2;

      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_RUN_PERIODIC_EVENT")).toHaveLength(4);
      acquireLockSpy.mockReset();

      // thirds run with same tenant ids
      getAllTenantIdsSpy.mockResolvedValueOnce(tenantIds.concat("e9bb8ec0-c85e-4035-b7cf-1b11ba8e5792"));

      await runner.__._multiTenancyDb();
      await promisify(setTimeout)(500);

      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_RUN_PERIODIC_EVENT")).toHaveLength(0);
      acquireLockSpy.mockRestore();
    });
  });
});
