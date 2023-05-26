"use strict";

const { promisify } = require("util");

const cds = require("@sap/cds");
cds.test(__dirname + "/_env");

jest.mock("../src/shared/redis", () => require("../test/mocks/redisMock"));
const cdsHelper = require("../src/shared/cdsHelper");
const { getWorkerPoolInstance } = require("../src/shared/WorkerQueue");
const getAllTenantIdsSpy = jest.spyOn(cdsHelper, "getAllTenantIds");
jest.spyOn(cdsHelper, "getSubdomainForTenantId").mockResolvedValue("dummy");
const processEventQueue = require("../src/processEventQueue");

const eventQueueRunnerSpy = jest
  .spyOn(processEventQueue, "eventQueueRunner")
  .mockImplementation(
    async () =>
      new Promise((resolve) => {
        setTimeout(resolve, 10);
      })
  );

const distributedLock = require("../src/shared/distributedLock");
const eventQueue = require("../src");
const runner = require("../src/runner");
const path = require("path");

const tenantIds = [
  "cd805323-879c-4bf7-b19c-8ffbbee22e1f",
  "9f3ed8f0-8aaf-439e-a96a-04cd5b680c59",
  "e9bb8ec0-c85e-4035-b7cf-1b11ba8e5792",
];

describe("redisRunner", () => {
  let context, tx, configInstance;

  beforeAll(async () => {
    const configFilePath = path.join(
      __dirname,
      "..",
      "./test",
      "asset",
      "config.yml"
    );
    await eventQueue.initialize({
      configFilePath,
      registerDbHandler: false,
      mode: eventQueue.RunningModes.none,
    });
    configInstance = eventQueue.getConfigInstance();
    configInstance.redisEnabled = true;
    jest.clearAllMocks();
  });

  beforeEach(async () => {
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
    await cds.tx({}, (tx2) => tx2.run(DELETE.from("sap.eventqueue.Lock")));
    await distributedLock.releaseLock({}, "EVENT_QUEUE_RUN_ID", {
      tenantScoped: false,
    });
  });

  afterEach(async () => {
    await tx.rollback();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await cds.disconnect();
    await cds.shutdown();
  });

  it("redis", async () => {
    const setValueWithExpireSpy = jest.spyOn(
      distributedLock,
      "setValueWithExpire"
    );
    const acquireLockSpy = jest.spyOn(distributedLock, "acquireLock");
    const checkLockExistsAndReturnValueSpy = jest.spyOn(
      distributedLock,
      "checkLockExistsAndReturnValue"
    );
    getAllTenantIdsSpy
      .mockResolvedValueOnce(tenantIds)
      .mockResolvedValueOnce(tenantIds)
      .mockResolvedValueOnce(tenantIds);
    const p1 = runner._._multiInstanceAndTenancy();
    const p2 = runner._._multiInstanceAndTenancy();

    await Promise.allSettled([p1, p2]);
    const workerPoolInstance = getWorkerPoolInstance();
    await Promise.allSettled(workerPoolInstance.__runningPromises);
    await promisify(setTimeout)(500);
    await Promise.allSettled(workerPoolInstance.__runningPromises);

    expect(setValueWithExpireSpy).toHaveBeenCalledTimes(2);
    expect(checkLockExistsAndReturnValueSpy).toHaveBeenCalledTimes(1);
    expect(acquireLockSpy).toHaveBeenCalledTimes(6);
    expect(eventQueueRunnerSpy).toHaveBeenCalledTimes(3);

    const acquireLockMock = acquireLockSpy.mock;
    const runId = acquireLockMock.calls[0][1];

    const tenantChecks = tenantIds.reduce((result, tenantId) => {
      result[tenantId] = { numberOfChecks: 0, values: [] };
      return result;
    }, {});
    for (let i = 0; i < 6; i++) {
      const tenantId = acquireLockMock.calls[i][0].tenant;
      expect(runId).toEqual(acquireLockMock.calls[i][1]);
      const result = await acquireLockMock.results[i].value;
      tenantChecks[tenantId].numberOfChecks++;
      tenantChecks[tenantId].values.push(result);
    }
    expect(tenantChecks).toMatchSnapshot();

    // another run within 5 minutes should do nothing
    await runner._._multiInstanceAndTenancy();
    await promisify(setTimeout)(500);
    await Promise.allSettled(workerPoolInstance.__runningPromises);
    expect(acquireLockSpy).toHaveBeenCalledTimes(9);
    expect(eventQueueRunnerSpy).toHaveBeenCalledTimes(3);
  });

  it("db", async () => {
    configInstance.redisEnabled = false;
    const originalCdsTx = cds.tx;
    jest.spyOn(cds, "tx").mockImplementation((context, fn) => {
      context.tenant = null;
      return originalCdsTx(context, fn);
    });
    const acquireLockSpy = jest.spyOn(distributedLock, "acquireLock");
    getAllTenantIdsSpy
      .mockResolvedValueOnce(tenantIds)
      .mockResolvedValueOnce(tenantIds)
      .mockResolvedValueOnce(tenantIds)
      .mockResolvedValueOnce(tenantIds);
    expect(eventQueueRunnerSpy).toHaveBeenCalledTimes(0);
    const p1 = runner._._singleInstanceAndMultiTenancy();
    const p2 = runner._._singleInstanceAndMultiTenancy();
    await Promise.allSettled([p1, p2]);
    const workerPoolInstance = getWorkerPoolInstance();
    await Promise.allSettled(workerPoolInstance.__runningPromises);
    await promisify(setTimeout)(500);
    await Promise.allSettled(workerPoolInstance.__runningPromises);

    expect(acquireLockSpy).toHaveBeenCalledTimes(6);
    expect(eventQueueRunnerSpy).toHaveBeenCalledTimes(3);

    const acquireLockMock = acquireLockSpy.mock;
    const runId = acquireLockMock.calls[0][1];

    const tenantChecks = tenantIds.reduce((result, tenantId) => {
      result[tenantId] = { numberOfChecks: 0, values: {} };
      return result;
    }, {});
    for (let i = 0; i < 6; i++) {
      const tenantId = acquireLockMock.calls[i][0].tenant;
      expect(runId).toEqual(acquireLockMock.calls[i][1]);
      const result = await acquireLockMock.results[i].value;
      tenantChecks[tenantId].numberOfChecks++;
      tenantChecks[tenantId].values[result] = 1;
    }
    expect(tenantChecks).toMatchSnapshot();

    // another run within 5 minutes should do nothing
    await runner._._singleInstanceAndMultiTenancy();
    await promisify(setTimeout)(500);
    await Promise.allSettled(workerPoolInstance.__runningPromises);
    expect(eventQueueRunnerSpy).toHaveBeenCalledTimes(3);
    expect(acquireLockSpy).toHaveBeenCalledTimes(9);

    // 5 min's later the tenants should be processed again
    await cds.tx({}, (tx2) =>
      tx2.run(
        UPDATE.entity("sap.eventqueue.Lock").set({
          createdAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
        })
      )
    );

    await runner._._singleInstanceAndMultiTenancy();
    await promisify(setTimeout)(500);
    await Promise.allSettled(workerPoolInstance.__runningPromises);
    expect(acquireLockSpy).toHaveBeenCalledTimes(12);
    expect(eventQueueRunnerSpy).toHaveBeenCalledTimes(6);
  });
});
