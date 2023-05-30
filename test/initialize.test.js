"use strict";

const path = require("path");

const redisPubSub = require("../src/redisPubSub");
jest.spyOn(redisPubSub, "initEventQueueRedisSubscribe").mockResolvedValue(null);

const eventQueue = require("../src");
const runner = require("../src/runner");
const cds = require("@sap/cds");

const project = __dirname + "/.."; // The project's root folder
cds.test(project);

describe("initialize", () => {
  beforeEach(() => {
    const configInstance = eventQueue.getConfigInstance();
    configInstance.initialized = false;
    jest.clearAllMocks();
  });

  const configFilePath = path.join(__dirname, "asset", "configFaulty.yml");
  test("read yaml config file", async () => {
    await eventQueue.initialize({ configFilePath, registerDbHandler: false });
    const config = eventQueue.getConfigInstance().events;
    expect(config).toMatchSnapshot();
  });

  test("not existing config file", async () => {
    const configFilePath = path.join(__dirname, "asset", "config.kk");
    await expect(
      eventQueue.initialize({ configFilePath, registerDbHandler: false })
    ).rejects.toThrow();
  });

  describe("runner mode registration", () => {
    test("single tenant", async () => {
      const singleTenantSpy = jest
        .spyOn(runner, "singleTenant")
        .mockReturnValueOnce();
      await eventQueue.initialize({ configFilePath, registerDbHandler: false });
      expect(singleTenantSpy).toHaveBeenCalledTimes(1);
    });

    test("multi tenancy with db", async () => {
      cds.requires.multitenancy = {};
      const multiTenancyDbSpy = jest
        .spyOn(runner, "multiTenancyDb")
        .mockReturnValueOnce();
      await eventQueue.initialize({ configFilePath, registerDbHandler: false });
      expect(multiTenancyDbSpy).toHaveBeenCalledTimes(1);
      cds.requires.multitenancy = null;
    });

    test("calling initialize twice should only processed once", async () => {
      const singleTenant = jest
        .spyOn(runner, "singleTenant")
        .mockReturnValueOnce();
      const p1 = eventQueue.initialize({
        configFilePath,
        registerDbHandler: false,
      });
      const p2 = eventQueue.initialize({
        configFilePath,
        registerDbHandler: false,
      });
      await Promise.allSettled([p1, p2]);
      expect(singleTenant).toHaveBeenCalledTimes(1);
    });

    test("multi tenancy with redis", async () => {
      cds.requires.multitenancy = {};
      eventQueue.getConfigInstance().__vcapServices = {
        "redis-cache": [{ credentials: { hostname: "123" } }],
      };
      eventQueue.getConfigInstance().isOnCF = true;
      const multiTenancyRedisSpy = jest
        .spyOn(runner, "multiTenancyRedis")
        .mockReturnValueOnce();
      await eventQueue.initialize({
        configFilePath,
        registerDbHandler: false,
      });
      expect(multiTenancyRedisSpy).toHaveBeenCalledTimes(1);
      cds.requires.multitenancy = null;
      eventQueue.getConfigInstance().isOnCF = false;
    });

    test("mode none should not register any runner", async () => {
      const multiTenancyRedisSpy = jest.spyOn(runner, "multiTenancyRedis");
      const singleTenantSpy = jest.spyOn(runner, "singleTenant");
      const multiTenancyDbSpy = jest.spyOn(runner, "multiTenancyDb");
      await eventQueue.initialize({
        configFilePath,
        registerDbHandler: false,
        registerAsEventProcessing: false,
      });
      expect(multiTenancyRedisSpy).toHaveBeenCalledTimes(0);
      expect(singleTenantSpy).toHaveBeenCalledTimes(0);
      expect(multiTenancyDbSpy).toHaveBeenCalledTimes(0);
    });
  });
});
