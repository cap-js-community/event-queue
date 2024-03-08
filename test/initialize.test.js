"use strict";

const path = require("path");

const cds = require("@sap/cds");

const project = __dirname + "/.."; // The project's root folder
cds.test(project);

const redisPubSub = require("../src/redisPubSub");
const eventQueue = require("../src");
const { getEnvInstance } = require("../src/shared/env");
const runner = require("../src/runner");
const config = require("../src/config");
const redis = require("../src/shared/redis");

jest.spyOn(redisPubSub, "initEventQueueRedisSubscribe").mockResolvedValue(null);

describe("initialize", () => {
  let configInstance;
  beforeEach(() => {
    configInstance = eventQueue.config;
    configInstance.initialized = false;
    jest.clearAllMocks();
  });

  const configFilePath = path.join(__dirname, "asset", "configFaulty.yml");
  test("read yaml config file", async () => {
    await eventQueue.initialize({
      configFilePath,
      processEventsAfterPublish: false,
    });
    const config = eventQueue.config.events;
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

  test("missing interval for period event", async () => {
    await eventQueue.initialize({
      configFilePath: path.join(__dirname, "asset", "config.yml"),
      processEventsAfterPublish: false,
    });

    const fileContent = config.fileContent;
    delete fileContent.periodicEvents[0].interval;
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(`"Invalid interval, the value needs to greater than 10 seconds."`);
  });

  test("registration checks", async () => {
    await eventQueue.initialize({
      configFilePath: path.join(__dirname, "asset", "config.yml"),
      processEventsAfterPublish: false,
    });

    const fileContent = config.fileContent;
    delete fileContent.periodicEvents[0].impl;
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(`"Missing path to event class implementation."`);

    delete fileContent.events[0].impl;
    fileContent.periodicEvents[0].impl = 123;
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(`"Missing path to event class implementation."`);

    fileContent.events[0].impl = 123;
    fileContent.periodicEvents.push({ ...fileContent.periodicEvents[0] });
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(`"Duplicate event registration, check the uniqueness of type and subType."`);

    expect(() => {
      config.runInterval = 2;
    }).toThrowErrorMatchingInlineSnapshot(`"Invalid interval, the value needs to greater than 10 seconds."`);

    expect(() => {
      config.runInterval = null;
    }).toThrowErrorMatchingInlineSnapshot(`"Invalid interval, the value needs to greater than 10 seconds."`);

    expect(() => {
      config.runInterval = "200000";
    }).toThrowErrorMatchingInlineSnapshot(`"Invalid interval, the value needs to greater than 10 seconds."`);

    fileContent.periodicEvents.splice(1);
    fileContent.events.push({ ...fileContent.events[0] });
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(`"Duplicate event registration, check the uniqueness of type and subType."`);

    fileContent.events.splice(1);
    fileContent.periodicEvents.splice(1);
    fileContent.periodicEvents.push({ ...fileContent.events[0], interval: 30 });
    expect(() => {
      config.fileContent = fileContent;
    }).not.toThrow();
  });

  describe("runner mode registration", () => {
    beforeEach(() => {
      cds._events.connect.splice?.(1, cds._events.connect.length - 1);
    });

    test("single tenant", async () => {
      const singleTenantSpy = jest.spyOn(runner, "singleTenant").mockResolvedValueOnce();
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
      });
      cds.emit("connect", await cds.connect.to("db"));
      expect(singleTenantSpy).toHaveBeenCalledTimes(1);
    });

    test("multi tenancy with db", async () => {
      cds.requires.multitenancy = {};
      const multiTenancyDbSpy = jest.spyOn(runner, "multiTenancyDb").mockResolvedValueOnce();
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
      });
      cds.emit("connect", await cds.connect.to("db"));
      expect(multiTenancyDbSpy).toHaveBeenCalledTimes(1);
      cds.requires.multitenancy = null;
    });

    test("calling initialize twice should only processed once", async () => {
      const singleTenant = jest.spyOn(runner, "singleTenant").mockResolvedValueOnce();
      const p1 = eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
      });
      const p2 = eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
      });
      cds.emit("connect", await cds.connect.to("db"));
      await Promise.allSettled([p1, p2]);
      expect(singleTenant).toHaveBeenCalledTimes(1);
    });

    test("multi tenancy with redis", async () => {
      cds.requires.multitenancy = {};
      const env = getEnvInstance();
      env.vcapServices = {
        "redis-cache": [{ credentials: { hostname: "123" } }],
      };
      const multiTenancyRedisSpy = jest.spyOn(runner, "multiTenancyRedis").mockResolvedValueOnce();
      jest.spyOn(redis, "connectionCheck").mockResolvedValueOnce(true);
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
        disableRedis: false,
      });
      cds.emit("connect", await cds.connect.to("db"));
      expect(multiTenancyRedisSpy).toHaveBeenCalledTimes(1);
      env.isOnCF = false;
      cds.requires.multitenancy = null;
    });

    test("multi tenancy with redis - option to disable redis", async () => {
      cds.requires.multitenancy = {};
      const env = getEnvInstance();
      env.isOnCF = true;
      env.vcapServices = {
        "redis-cache": [{ credentials: { hostname: "123" } }],
      };
      const multiTenancyRedisSpy = jest.spyOn(runner, "multiTenancyRedis").mockResolvedValueOnce();
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
        disableRedis: true,
      });
      expect(multiTenancyRedisSpy).toHaveBeenCalledTimes(0);
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
      });
      expect(configInstance.registerAsEventProcessor).toEqual(false);
      expect(configInstance.processEventsAfterPublish).toEqual(true);
      expect(configInstance.runInterval).toEqual(25 * 60 * 1000);
      expect(configInstance.tableNameEventQueue).toEqual("sap.eventqueue.Event");
      expect(configInstance.tableNameEventLock).toEqual("sap.eventqueue.Lock");
      expect(configInstance.skipCsnCheck).toEqual(false);
    });
  });
});
