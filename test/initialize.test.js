"use strict";

const path = require("path");

const cds = require("@sap/cds");

const project = __dirname + "/.."; // The project's root folder
cds.test(project);

const redisPubSub = require("../src/redisPubSub");
const eventQueue = require("../src");
const { getEnvInstance } = require("../src/shared/env");
const runner = require("../src/runner");

jest.spyOn(redisPubSub, "initEventQueueRedisSubscribe").mockResolvedValue(null);

describe("initialize", () => {
  let configInstance;
  beforeEach(() => {
    configInstance = eventQueue.getConfigInstance();
    configInstance.initialized = false;
    jest.clearAllMocks();
  });

  const configFilePath = path.join(__dirname, "asset", "configFaulty.yml");
  test("read yaml config file", async () => {
    await eventQueue.initialize({
      configFilePath,
      processEventsAfterPublish: false,
    });
    const config = eventQueue.getConfigInstance().events;
    expect(config).toMatchSnapshot();
  });

  test("not existing config file", async () => {
    const configFilePath = path.join(__dirname, "asset", "config.kk");
    await expect(
      eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
      })
    ).rejects.toThrow();
  });

  describe("runner mode registration", () => {
    test("single tenant", async () => {
      const singleTenantSpy = jest.spyOn(runner, "singleTenant").mockReturnValueOnce();
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
      });
      expect(singleTenantSpy).toHaveBeenCalledTimes(1);
    });

    test("multi tenancy with db", async () => {
      cds.requires.multitenancy = {};
      const multiTenancyDbSpy = jest.spyOn(runner, "multiTenancyDb").mockReturnValueOnce();
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
      });
      expect(multiTenancyDbSpy).toHaveBeenCalledTimes(1);
      cds.requires.multitenancy = null;
    });

    test("calling initialize twice should only processed once", async () => {
      const singleTenant = jest.spyOn(runner, "singleTenant").mockReturnValueOnce();
      const p1 = eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
      });
      const p2 = eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
      });
      await Promise.allSettled([p1, p2]);
      expect(singleTenant).toHaveBeenCalledTimes(1);
    });

    test("multi tenancy with redis", async () => {
      cds.requires.multitenancy = {};
      const env = getEnvInstance();
      env.isOnCF = true;
      env.vcapServices = {
        "redis-cache": [{ credentials: { hostname: "123" } }],
      };
      const multiTenancyRedisSpy = jest.spyOn(runner, "multiTenancyRedis").mockReturnValueOnce();
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
      });
      expect(multiTenancyRedisSpy).toHaveBeenCalledTimes(1);
      env.isOnCF = false;
      cds.requires.multitenancy = null;
    });

    test("mode none should not register any runner", async () => {
      const multiTenancyRedisSpy = jest.spyOn(runner, "multiTenancyRedis");
      const singleTenantSpy = jest.spyOn(runner, "singleTenant");
      const multiTenancyDbSpy = jest.spyOn(runner, "multiTenancyDb");
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
        registerAsEventProcessor: false,
      });
      expect(multiTenancyRedisSpy).toHaveBeenCalledTimes(0);
      expect(singleTenantSpy).toHaveBeenCalledTimes(0);
      expect(multiTenancyDbSpy).toHaveBeenCalledTimes(0);
    });

    test("should mix init vars with env correctly", async () => {
      cds.env.eventQueue = {};
      cds.env.eventQueue.registerAsEventProcessor = true;
      await eventQueue.initialize({
        configFilePath,
        registerAsEventProcessor: false,
        parallelTenantProcessing: 3,
      });
      expect(configInstance.registerAsEventProcessor).toEqual(false);
      expect(configInstance.processEventsAfterPublish).toEqual(true);
      expect(configInstance.runInterval).toEqual(5 * 60 * 1000);
      expect(configInstance.parallelTenantProcessing).toEqual(3);
      expect(configInstance.tableNameEventQueue).toEqual("sap.eventqueue.Event");
      expect(configInstance.tableNameEventLock).toEqual("sap.eventqueue.Lock");
      expect(configInstance.skipCsnCheck).toEqual(false);
    });
  });
});
