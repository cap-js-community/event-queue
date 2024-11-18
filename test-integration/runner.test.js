"use strict";

const { promisify } = require("util");

const cds = require("@sap/cds");
cds.test(__dirname + "/_env");

const mockRedis = require("../test/mocks/redisMock");
jest.mock("../src/shared/redis", () => mockRedis);
const cdsHelper = require("../src/shared/cdsHelper");
const WorkerQueue = require("../src/shared/WorkerQueue");
const getAllTenantIdsSpy = jest.spyOn(cdsHelper, "getAllTenantIds");
const processEventQueue = require("../src/processEventQueue");
const openEvents = require("../src/runner/openEvents");
const { Logger: mockLogger } = require("../test/mocks/logger");

const processEventQueueSpy = jest.spyOn(processEventQueue, "processEventQueue").mockImplementation(
  async () =>
    new Promise((resolve) => {
      setTimeout(resolve, 10);
    })
);

const distributedLock = require("../src/shared/distributedLock");
const eventQueue = require("../src");
const runner = require("../src/runner/runner");
const path = require("path");
const periodicEvents = require("../src/periodicEvents");
const redisPub = require("../src/redis/redisPub");

const tenantIds = [
  "cd805323-879c-4bf7-b19c-8ffbbee22e1f",
  "9f3ed8f0-8aaf-439e-a96a-04cd5b680c59",
  "e9bb8ec0-c85e-4035-b7cf-1b11ba8e5792",
];

describe("runner", () => {
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
    await cds.tx({}, async (tx2) => {
      await tx2.run(DELETE.from("sap.eventqueue.Lock"));
      await tx2.run(DELETE.from("sap.eventqueue.Event"));
    });
    await distributedLock.releaseLock({}, "EVENT_QUEUE_RUN_ID", {
      tenantScoped: false,
    });
    runner.__.clearHash();
    mockRedis.clearState();
  });

  afterEach(async () => {
    await tx?.rollback?.();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await cds.disconnect();
    await cds.shutdown();
  });

  // TODO: both add the in 5 minutes should check again
  // - redis should call getOpenQueueEntries again (does not matter if there are open events or not)
  // - db should call processEventQueue again (we need open events for that)
  afterEach(() => {
    jest.spyOn(periodicEvents, "checkAndInsertPeriodicEvents").mockRestore();
  });

  describe("redis", () => {
    describe("multi tenant", () => {
      it("no open events", async () => {
        const acquireLockSpy = jest.spyOn(distributedLock, "acquireLock");
        const redisPubSpy = jest.spyOn(redisPub, "broadcastEvent").mockResolvedValue();
        const getOpenQueueEntriesSpy = jest.spyOn(openEvents, "getOpenQueueEntries");
        const checkAndInsertPeriodicEventsSpy = jest
          .spyOn(periodicEvents, "checkAndInsertPeriodicEvents")
          .mockResolvedValue();
        getAllTenantIdsSpy
          .mockResolvedValueOnce(tenantIds)
          .mockResolvedValueOnce(tenantIds)
          .mockResolvedValueOnce(tenantIds);
        const p1 = runner.__._multiTenancyRedis();
        const p2 = runner.__._multiTenancyRedis();

        await Promise.allSettled([p1, p2]);
        await Promise.allSettled(WorkerQueue.instance.runningPromises);

        // check now tenant independent events --> 2 calls of _multiTenancyRedis * 1 update periodic events (but only for
        // one calls because of tenant hash) + 1 event run check (number of calls is independent for open events)
        expect(acquireLockSpy).toHaveBeenCalledTimes(3);
        // one check per tenant
        expect(getOpenQueueEntriesSpy).toHaveBeenCalledTimes(3);
        expect(checkAndInsertPeriodicEventsSpy).toHaveBeenCalledTimes(3);
        // no open events to broadcast
        expect(redisPubSpy).toHaveBeenCalledTimes(0);
        // remove context from arguments for snapshot
        expect(acquireLockSpy.mock.calls.map((call) => [call[1], call[2]])).toMatchSnapshot();
        expect(mockRedis.getState()).toMatchSnapshot();

        // another run within 5 minutes should do nothing
        await runner.__._multiTenancyRedis();
        await Promise.allSettled(WorkerQueue.instance.runningPromises);
        // 3 of the previous calls + 1 for the new call
        expect(acquireLockSpy).toHaveBeenCalledTimes(4);
        expect(WorkerQueue.instance.runningPromises).toHaveLength(0);
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("with open events - broadcast should be called", async () => {
        await cds.tx({}, async (tx2) => {
          await periodicEvents.checkAndInsertPeriodicEvents(tx2.context);
        });
        const acquireLockSpy = jest.spyOn(distributedLock, "acquireLock");
        const redisPubSpy = jest.spyOn(redisPub, "broadcastEvent").mockResolvedValue();
        const getOpenQueueEntriesSpy = jest.spyOn(openEvents, "getOpenQueueEntries");
        const checkAndInsertPeriodicEventsSpy = jest
          .spyOn(periodicEvents, "checkAndInsertPeriodicEvents")
          .mockResolvedValue();
        getAllTenantIdsSpy
          .mockResolvedValueOnce(tenantIds)
          .mockResolvedValueOnce(tenantIds)
          .mockResolvedValueOnce(tenantIds);
        const p1 = runner.__._multiTenancyRedis();
        const p2 = runner.__._multiTenancyRedis();

        await Promise.allSettled([p1, p2]);
        await Promise.allSettled(WorkerQueue.instance.runningPromises);

        // check now tenant independent events --> 2 calls of _multiTenancyRedis * 1 update periodic events (but only for
        // one calls because of tenant hash) + 1 event run check (number of calls is independent for open events)
        expect(acquireLockSpy).toHaveBeenCalledTimes(3);
        // one check per tenant
        expect(getOpenQueueEntriesSpy).toHaveBeenCalledTimes(3);
        expect(checkAndInsertPeriodicEventsSpy).toHaveBeenCalledTimes(3);
        // open events - 3 periodic events
        expect(redisPubSpy).toHaveBeenCalledTimes(3);
        expect(redisPubSpy.mock.calls).toMatchSnapshot();
        // remove context from arguments for snapshot
        expect(acquireLockSpy.mock.calls.map((call) => [call[1], call[2]])).toMatchSnapshot();
        expect(mockRedis.getState()).toMatchSnapshot();

        // another run within 5 minutes should do nothing
        await runner.__._multiTenancyRedis();
        await Promise.allSettled(WorkerQueue.instance.runningPromises);
        // 3 of the previous calls + 1 for the new call
        expect(acquireLockSpy).toHaveBeenCalledTimes(4);
        expect(WorkerQueue.instance.runningPromises).toHaveLength(0);
        expect(loggerMock.callsLengths().error).toEqual(0);
      });
    });

    describe("single tenant", () => {
      it("no open events", async () => {
        const acquireLockSpy = jest.spyOn(distributedLock, "acquireLock");
        const redisPubSpy = jest.spyOn(redisPub, "broadcastEvent").mockResolvedValue();
        const getOpenQueueEntriesSpy = jest.spyOn(openEvents, "getOpenQueueEntries");
        const checkAndInsertPeriodicEventsSpy = jest
          .spyOn(periodicEvents, "checkAndInsertPeriodicEvents")
          .mockResolvedValue();
        const p1 = runner.__._singleTenantRedis();
        const p2 = runner.__._singleTenantRedis();

        await Promise.allSettled([p1, p2]);
        await Promise.allSettled(WorkerQueue.instance.runningPromises);

        // once per _singleTenantRedis
        expect(acquireLockSpy).toHaveBeenCalledTimes(2);
        // only once
        expect(getOpenQueueEntriesSpy).toHaveBeenCalledTimes(1);
        // not at all as in different coding path (single call function)
        expect(checkAndInsertPeriodicEventsSpy).toHaveBeenCalledTimes(0);
        // no open events to broadcast
        expect(redisPubSpy).toHaveBeenCalledTimes(0);
        // remove context from arguments for snapshot
        expect(acquireLockSpy.mock.calls.map((call) => [call[1], call[2]])).toMatchSnapshot();
        expect(mockRedis.getState()).toMatchSnapshot();

        // another run within 5 minutes should do nothing
        await runner.__._singleTenantRedis();
        await Promise.allSettled(WorkerQueue.instance.runningPromises);
        // 2 of the previous calls + 1 for the new call
        expect(acquireLockSpy).toHaveBeenCalledTimes(3);
        expect(WorkerQueue.instance.runningPromises).toHaveLength(0);
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("with open events - broadcast should be called", async () => {
        await cds.tx({}, async (tx2) => {
          await periodicEvents.checkAndInsertPeriodicEvents(tx2.context);
        });
        const acquireLockSpy = jest.spyOn(distributedLock, "acquireLock");
        const redisPubSpy = jest.spyOn(redisPub, "broadcastEvent").mockResolvedValue();
        const getOpenQueueEntriesSpy = jest.spyOn(openEvents, "getOpenQueueEntries");
        const checkAndInsertPeriodicEventsSpy = jest
          .spyOn(periodicEvents, "checkAndInsertPeriodicEvents")
          .mockResolvedValue();
        const p1 = runner.__._singleTenantRedis();
        const p2 = runner.__._singleTenantRedis();

        await Promise.allSettled([p1, p2]);
        await Promise.allSettled(WorkerQueue.instance.runningPromises);

        // once per _singleTenantRedis
        expect(acquireLockSpy).toHaveBeenCalledTimes(2);
        // only once
        expect(getOpenQueueEntriesSpy).toHaveBeenCalledTimes(1);
        // not at all as in different coding path (single call function)
        expect(checkAndInsertPeriodicEventsSpy).toHaveBeenCalledTimes(0);
        // no open events to broadcast
        expect(redisPubSpy).toHaveBeenCalledTimes(1);
        // remove context from arguments for snapshot
        expect(acquireLockSpy.mock.calls.map((call) => [call[1], call[2]])).toMatchSnapshot();
        expect(mockRedis.getState()).toMatchSnapshot();

        // another run within 5 minutes should do nothing
        await runner.__._singleTenantRedis();
        await Promise.allSettled(WorkerQueue.instance.runningPromises);
        // 2 of the previous calls + 1 for the new call
        expect(acquireLockSpy).toHaveBeenCalledTimes(3);
        expect(WorkerQueue.instance.runningPromises).toHaveLength(0);
        expect(loggerMock.callsLengths().error).toEqual(0);
      });
    });
  });

  describe("multi tenant db", () => {
    beforeAll(() => {
      const originalCdsTx = cds.tx;
      jest.spyOn(cds, "tx").mockImplementation(function (context, fn) {
        if (!fn) {
          return originalCdsTx.call(this, context);
        }
        if (fn.toString().toLowerCase().includes("await fn(tx, ...parameters)")) {
          context.tenant = null;
        }
        return originalCdsTx.call(this, context, fn);
      });
    });

    afterAll(() => {
      jest.spyOn(cds, "tx").mockRestore();
    });

    it("no open events", async () => {
      configInstance.redisEnabled = false;
      jest.spyOn(periodicEvents, "checkAndInsertPeriodicEvents").mockResolvedValue();
      const acquireLockSpy = jest.spyOn(distributedLock, "acquireLock");
      getAllTenantIdsSpy
        .mockResolvedValueOnce(tenantIds)
        .mockResolvedValueOnce(tenantIds)
        .mockResolvedValueOnce(tenantIds);
      expect(processEventQueueSpy).toHaveBeenCalledTimes(0);
      const p1 = runner.__._multiTenancyDb();
      const p2 = runner.__._multiTenancyDb();
      await Promise.allSettled([p1, p2]);
      await Promise.allSettled(WorkerQueue.instance.runningPromises);

      // 3 calls of _multiTenancyDb * 1 update periodic events (but only for one calls because of tenant hash)
      // check is tenant-depended in comparison to redis --> redis only one check to check all tenants
      expect(acquireLockSpy).toHaveBeenCalledTimes(3);
      expect(acquireLockSpy.mock.calls.map((call) => [call[1], call[2]])).toMatchSnapshot();
      // zero calls as no open events
      expect(processEventQueueSpy).toHaveBeenCalledTimes(0);

      // another run within 5 minutes should do nothing
      await runner.__._multiTenancyDb();
      await Promise.allSettled(WorkerQueue.instance.runningPromises);
      // still 3 calls as no open events and no lock is required to check for open events
      expect(acquireLockSpy).toHaveBeenCalledTimes(3);
      expect(processEventQueueSpy).toHaveBeenCalledTimes(0);
      expect(getAllTenantIdsSpy).toHaveBeenCalledTimes(3);
    });

    it("open periodic events", async () => {
      configInstance.redisEnabled = false;
      await cds.tx({}, async (tx2) => {
        await periodicEvents.checkAndInsertPeriodicEvents(tx2.context);
      });
      const acquireLockSpy = jest.spyOn(distributedLock, "acquireLock");
      getAllTenantIdsSpy
        .mockResolvedValueOnce(tenantIds)
        .mockResolvedValueOnce(tenantIds)
        .mockResolvedValueOnce(tenantIds);
      expect(processEventQueueSpy).toHaveBeenCalledTimes(0);
      const p1 = runner.__._multiTenancyDb();
      const p2 = runner.__._multiTenancyDb();
      await Promise.allSettled([p1, p2]);
      await Promise.allSettled(WorkerQueue.instance.runningPromises);

      // 3 calls of _multiTenancyDb * 1 update periodic events (but only for one calls because of tenant hash)
      // 3 tenants * 2 calls of _multiTenancyDb * 1 open periodic event
      expect(acquireLockSpy).toHaveBeenCalledTimes(9);
      expect(
        acquireLockSpy.mock.calls.map((call) => [call[1], call[2]]).sort(([a], [b]) => a.localeCompare(b))
      ).toMatchSnapshot();
      // 3 calls = 3 tenants * 1 open periodic event - because of locks only one call per tenant
      expect(processEventQueueSpy).toHaveBeenCalledTimes(3);

      // another run within 5 minutes should do nothing
      await runner.__._multiTenancyDb();
      await Promise.allSettled(WorkerQueue.instance.runningPromises);
      // 9 calls from before + there are still open events so: 3 tenants * 1 open event = 3 calls
      expect(acquireLockSpy).toHaveBeenCalledTimes(12);
      // still 3 calls
      expect(processEventQueueSpy).toHaveBeenCalledTimes(3);
      expect(getAllTenantIdsSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe("single tenant db", () => {
    beforeAll(() => {
      const originalCdsTx = cds.tx;
      jest.spyOn(cds, "tx").mockImplementation(function (context, fn) {
        if (!fn) {
          return originalCdsTx.call(this, context);
        }
        if (fn.toString().toLowerCase().includes("await fn(tx, ...parameters)")) {
          context.tenant = null;
        }
        return originalCdsTx.call(this, context, fn);
      });
    });

    afterAll(() => {
      jest.spyOn(cds, "tx").mockRestore();
    });

    it("no open events", async () => {
      configInstance.redisEnabled = false;

      const acquireLockSpy = jest.spyOn(distributedLock, "acquireLock");

      await Promise.all([runner.__._singleTenantDb(), runner.__._singleTenantDb()]).then((promises) =>
        Promise.all(promises.flat())
      );

      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(processEventQueueSpy).toHaveBeenCalledTimes(0);
      expect(acquireLockSpy).toHaveBeenCalledTimes(0);
      expect(WorkerQueue.instance.runningPromises).toHaveLength(0);
    });

    it("open periodic events", async () => {
      configInstance.redisEnabled = false;
      await cds.tx({}, async (tx2) => {
        await periodicEvents.checkAndInsertPeriodicEvents(tx2.context);
      });
      const acquireLockSpy = jest.spyOn(distributedLock, "acquireLock");

      await Promise.all([runner.__._singleTenantDb(), runner.__._singleTenantDb()]).then((promises) =>
        Promise.all(promises.flat())
      );

      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(processEventQueueSpy).toHaveBeenCalledTimes(1);
      expect(acquireLockSpy).toHaveBeenCalledTimes(2);
      expect(WorkerQueue.instance.runningPromises).toHaveLength(0);
    });
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
    beforeAll(() => {
      configInstance.redisEnabled = false;
    });

    it("should trigger update periodic events once per tenant", async () => {
      let counter = 0;
      let acquireLockSpy;
      const promise = new Promise((resolve) => {
        acquireLockSpy = jest.spyOn(distributedLock, "acquireLock").mockImplementation(async (context, key) => {
          if (key === "EVENT_QUEUE_UPDATE_PERIODIC_EVENTS") {
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
      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_UPDATE_PERIODIC_EVENTS")).toHaveLength(
        3
      );

      acquireLockSpy.mockRestore();
      expect(getAllTenantIdsSpy).toHaveBeenCalledTimes(1);
    });

    it("should not trigger update again if tenant ids have not been changed", async () => {
      let counter = 0;
      let acquireLockSpy;
      const promise = new Promise((resolve) => {
        acquireLockSpy = jest.spyOn(distributedLock, "acquireLock").mockImplementation(async (context, key) => {
          if (key === "EVENT_QUEUE_UPDATE_PERIODIC_EVENTS") {
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
      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_UPDATE_PERIODIC_EVENTS")).toHaveLength(
        3
      );

      // second run
      getAllTenantIdsSpy.mockResolvedValueOnce(tenantIds);
      await runner.__._multiTenancyDb();
      await promisify(setTimeout)(500);

      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_UPDATE_PERIODIC_EVENTS")).toHaveLength(
        3
      );
      acquireLockSpy.mockRestore();
      expect(getAllTenantIdsSpy).toHaveBeenCalledTimes(2);
    });

    it("should trigger update again if tenant ids have been changed", async () => {
      let counter = 0;
      let acquireLockSpy;
      const promise = new Promise((resolve) => {
        acquireLockSpy = jest.spyOn(distributedLock, "acquireLock").mockImplementation(async (context, key) => {
          if (key === "EVENT_QUEUE_UPDATE_PERIODIC_EVENTS") {
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
      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_UPDATE_PERIODIC_EVENTS")).toHaveLength(
        3
      );

      // second run with changed tenant ids
      getAllTenantIdsSpy.mockResolvedValueOnce(tenantIds.concat("e9bb8ec0-c85e-4035-b7cf-1b11ba8e5792"));

      const promise2 = new Promise((resolve) => {
        counter = 0;
        acquireLockSpy.mockRestore();
        acquireLockSpy = jest.spyOn(distributedLock, "acquireLock").mockImplementation(async (context, key) => {
          if (key === "EVENT_QUEUE_UPDATE_PERIODIC_EVENTS") {
            counter++;
          }
          if (counter === tenantIds.length) {
            resolve();
          }
        });
      });

      await runner.__._multiTenancyDb();
      await promise2;

      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_UPDATE_PERIODIC_EVENTS")).toHaveLength(
        4
      );
      acquireLockSpy.mockRestore();
      expect(getAllTenantIdsSpy).toHaveBeenCalledTimes(2);
    });

    it("should trigger update again if tenant ids have been changed and third run should not trigger an update", async () => {
      let counter = 0;
      let acquireLockSpy;
      const promise = new Promise((resolve) => {
        acquireLockSpy = jest.spyOn(distributedLock, "acquireLock").mockImplementation(async (context, key) => {
          if (key === "EVENT_QUEUE_UPDATE_PERIODIC_EVENTS") {
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
      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_UPDATE_PERIODIC_EVENTS")).toHaveLength(
        3
      );

      // second run with changed tenant ids
      getAllTenantIdsSpy.mockResolvedValueOnce(tenantIds.concat("e9bb8ec0-c85e-4035-b7cf-1b11ba8e5792"));

      const promise2 = new Promise((resolve) => {
        counter = 0;
        acquireLockSpy.mockRestore();
        acquireLockSpy = jest.spyOn(distributedLock, "acquireLock").mockImplementation(async (context, key) => {
          if (key === "EVENT_QUEUE_UPDATE_PERIODIC_EVENTS") {
            counter++;
          }
          if (counter === tenantIds.length) {
            resolve();
          }
        });
      });

      await runner.__._multiTenancyDb();
      await promise2;

      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_UPDATE_PERIODIC_EVENTS")).toHaveLength(
        4
      );
      acquireLockSpy.mockReset();

      // thirds run with same tenant ids
      getAllTenantIdsSpy.mockResolvedValueOnce(tenantIds.concat("e9bb8ec0-c85e-4035-b7cf-1b11ba8e5792"));

      await runner.__._multiTenancyDb();
      await promisify(setTimeout)(500);

      expect(acquireLockSpy.mock.calls.filter(([, key]) => key === "EVENT_QUEUE_UPDATE_PERIODIC_EVENTS")).toHaveLength(
        0
      );
      acquireLockSpy.mockRestore();
      expect(getAllTenantIdsSpy).toHaveBeenCalledTimes(3);
    });
  });
});
