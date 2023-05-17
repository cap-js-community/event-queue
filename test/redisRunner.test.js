"use strict";

const cds = require("@sap/cds/lib");

jest.mock("@sap/btp-feature-toggles/src/redisWrapper", () =>
  require("./mocks/redisMock")
);
const cdsHelper = require("../src/shared/cdsHelper");
const getAllTenantIdsSpy = jest.spyOn(cdsHelper, "getAllTenantIds");
jest.spyOn(cdsHelper, "getSubdomainForTenantId").mockResolvedValue("dummy");
const processEventQueue = require("../src/processEventQueue");
const eventQueueRunnerSpy = jest
  .spyOn(processEventQueue, "eventQueueRunner")
  .mockResolvedValue(
    new Promise((resolve) => {
      setTimeout(resolve, 10);
    })
  );

const distributedLock = require("../src/shared/distributedLock");
const eventQueue = require("../src");
const runner = require("../src/runner");
const path = require("path");

const project = __dirname + "/.."; // The project's root folder
cds.test(project);
const tenantIds = [
  "cd805323-879c-4bf7-b19c-8ffbbee22e1f",
  "9f3ed8f0-8aaf-439e-a96a-04cd5b680c59",
  "e9bb8ec0-c85e-4035-b7cf-1b11ba8e5792",
];

describe("redisRunner", () => {
  let context, tx, configInstance;

  beforeAll(async () => {
    const configFilePath = path.join(__dirname, "asset", "config.yml");
    await eventQueue.initialize({
      configFilePath,
      registerDbHandler: false,
      mode: eventQueue.RunningModes.multiInstance,
    });
    configInstance = eventQueue.getConfigInstance();
    configInstance.isOnCF = true;
  });

  beforeEach(async () => {
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
    await tx.run(DELETE.from("sap.core.EventLock"));
    await distributedLock.releaseLock({}, "EVENT_QUEUE_RUN_ID", {
      tenantScoped: false,
    });
  });

  afterEach(async () => {
    await tx.rollback();
  });

  it("redis test", async () => {
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
      .mockResolvedValueOnce(tenantIds);
    const p1 = runner._._multiInstanceAndTenancy(1);
    const p2 = runner._._multiInstanceAndTenancy(2);

    await Promise.allSettled([p1, p2]);

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
  });
});
