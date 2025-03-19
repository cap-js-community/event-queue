"use strict";

const path = require("path");
const { promisify } = require("util");

const cds = require("@sap/cds");

const project = __dirname + "/..";
cds.test(project);

const redisSub = require("../src/redis/redisSub");
const eventQueue = require("../src");
const runner = require("../src/runner/runner");
const config = require("../src/config");
const redis = require("../src/shared/redis");
const periodicEvents = require("../src/periodicEvents");
const cdsHelper = require("../src/shared/cdsHelper");

jest.spyOn(redisSub, "initEventQueueRedisSubscribe").mockResolvedValue(null);

describe("initialize", () => {
  let configInstance;
  beforeEach(() => {
    cds.env.eventQueue.periodicEvents = {
      "EVENT_QUEUE_BASE/DELETE_EVENTS": {
        priority: "low",
        impl: "./housekeeping/EventQueueDeleteEvents",
        load: 20,
        interval: 86400,
        internalEvent: true,
      },
    };
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

  test("registration checks", async () => {
    await eventQueue.initialize({
      configFilePath: path.join(__dirname, "asset", "config.yml"),
      processEventsAfterPublish: false,
    });
    const fileContent = config.fileContent;
    const originalEvents = [...fileContent.events];

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

    const interval = fileContent.periodicEvents[0].interval;
    delete fileContent.periodicEvents[0].interval;
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(
      `"For periodic events either the cron or interval parameter must be defined!"`
    );
    fileContent.periodicEvents[0].interval = interval;

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
    fileContent.periodicEvents.push({ ...fileContent.periodicEvents[0], type: cds.utils.uuid(), interval: 30 });
    expect(() => {
      config.fileContent = fileContent;
    }).not.toThrow();

    const event = originalEvents.find((event) => event.subType === "AppName");
    event.appNames = "test";
    fileContent.events.push({ ...event });
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(`"The app names property must be an array and only contain strings."`);
    fileContent.events.splice(1);

    event.appNames = [1];
    fileContent.events.push({ ...event });
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(`"The app names property must be an array and only contain strings."`);
    fileContent.events.splice(1);

    event.appNames = null;
    event.appInstances = ["1"];
    fileContent.events.push({ ...event });
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(`"The app instances property must be an array and only contain numbers."`);
    fileContent.events.splice(1);

    event.appInstances = "1";
    fileContent.events.push({ ...event });
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(`"The app instances property must be an array and only contain numbers."`);
    fileContent.events.splice(1);

    fileContent.periodicEvents = [];
    fileContent.periodicEvents.push({ ...fileContent.events[0], cron: 30 });
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(`"The cron expression is syntactically not correct and can't be parsed!"`);
    fileContent.periodicEvents = [];

    fileContent.periodicEvents.push({ ...fileContent.events[0], cron: "*/10 * * * * *" });
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(
      `"The difference between two cron execution must be greater than 10 seconds."`
    );
    fileContent.periodicEvents = [];

    fileContent.periodicEvents.push({ ...fileContent.events[0], interval: 20, cron: "*/15 * * * * *" });
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(`"For periodic events only the cron or interval parameter can be defined!"`);
    fileContent.periodicEvents = [];

    fileContent.periodicEvents.push({ ...fileContent.events[0] });
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(
      `"For periodic events either the cron or interval parameter must be defined!"`
    );
    fileContent.periodicEvents = [];

    fileContent.periodicEvents.push({ ...fileContent.events[0], interval: 20, multiInstanceProcessing: true });
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(
      `"The config multiInstanceProcessing is currently only allowed for ad-hoc events and single-tenant-apps."`
    );
    fileContent.periodicEvents = [];

    const newEvent = fileContent.events[0];
    fileContent.events = [];
    fileContent.events.push({ ...newEvent, multiInstanceProcessing: true });
    cds.requires.multitenancy = true;
    expect(() => {
      config.fileContent = fileContent;
    }).toThrowErrorMatchingInlineSnapshot(
      `"The config multiInstanceProcessing is currently only allowed for ad-hoc events and single-tenant-apps."`
    );
    cds.requires.multitenancy = false;
  });

  describe("should add events from cds.env", () => {
    beforeEach(async () => {
      config.configEvents = {};
      config.configPeriodicEvents = {};
      await eventQueue.initialize({
        configFilePath: path.join(__dirname, "asset", "config.yml"),
        processEventsAfterPublish: false,
      });
    });

    it("simple add ad-hoc event", () => {
      const fileContent = config.fileContent;
      config.configEvents = {
        "addedViaEnv/dummy": {
          ...config.fileContent.events[0],
          type: undefined,
          subType: undefined,
        },
      };
      config.mixFileContentWithEnv(fileContent);
      expect(config.events.find((event) => event.type === "addedViaEnv")).toMatchObject({
        type: "addedViaEnv",
        subType: "dummy",
      });
    });

    it("name without slash should work", () => {
      const fileContent = config.fileContent;
      config.configEvents = {
        addedViaEnvdummy: {
          ...config.fileContent.events[0],
          type: "addedViaEnv2",
          subType: "dummy2",
        },
      };
      config.mixFileContentWithEnv(fileContent);
      expect(config.events.find((event) => event.type === "addedViaEnv2")).toMatchObject({
        type: "addedViaEnv2",
        subType: "dummy2",
      });
    });

    it("setting event config to null should ignore the event", () => {
      const fileContent = config.fileContent;
      config.configEvents = {
        "addedViaEnv4/dummy": null,
      };
      config.mixFileContentWithEnv(fileContent);
      expect(config.events.find((event) => event.type === "addedViaEnv4")).toBeFalsy();
    });

    it("name without slash should and missing subType should be a error", () => {
      const fileContent = {
        events: [...config.fileContent.events],
        periodicEvents: [...config.fileContent.periodicEvents],
      };
      config.configEvents = {
        addedViaEnvdummy: {
          ...config.fileContent.events[0],
          type: "addedViaEnv3",
          subType: null,
        },
      };
      expect(() => {
        config.mixFileContentWithEnv(fileContent);
      }).toThrowErrorMatchingInlineSnapshot(`"Missing subtype event implementation."`);
      expect(config.events.find((event) => event.type === "addedViaEnv3")).toBeFalsy();
    });

    it("simple add periodic event", () => {
      const fileContent = config.fileContent;
      config.configPeriodicEvents = {
        "addedViaEnv/dummy2": {
          ...config.fileContent.periodicEvents[0],
          type: undefined,
          subType: undefined,
        },
      };
      config.mixFileContentWithEnv(fileContent);
      expect(config.periodicEvents.find((event) => event.type === "addedViaEnv_PERIODIC")).toMatchObject({
        type: "addedViaEnv_PERIODIC",
        subType: "dummy2",
      });
    });
  });

  describe("runner mode registration", () => {
    beforeEach(() => {
      cds._events.connect.splice?.(1, cds._events.connect.length - 1);
    });

    test("single tenant db", async () => {
      const singleTenantSpy = jest.spyOn(runner, "singleTenantDb").mockResolvedValueOnce();
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
        registerAsEventProcessor: true,
      });
      cds.emit("connect", await cds.connect.to("db"));
      await promisify(setImmediate)();
      expect(singleTenantSpy).toHaveBeenCalledTimes(1);
    });

    test("multi tenancy with db", async () => {
      cds.requires.multitenancy = {};
      const multiTenancyDbSpy = jest.spyOn(runner, "multiTenancyDb").mockResolvedValueOnce();
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
        registerAsEventProcessor: true,
      });
      cds.emit("connect", await cds.connect.to("db"));
      await promisify(setImmediate)();
      expect(multiTenancyDbSpy).toHaveBeenCalledTimes(1);
      cds.requires.multitenancy = null;
    });

    test("calling initialize twice should only processed once", async () => {
      const singleTenant = jest.spyOn(runner, "singleTenantDb").mockResolvedValueOnce();
      const p1 = eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
        registerAsEventProcessor: true,
      });
      const p2 = eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
        registerAsEventProcessor: true,
      });
      cds.emit("connect", await cds.connect.to("db"));
      await Promise.allSettled([p1, p2]);
      await promisify(setImmediate)();
      expect(singleTenant).toHaveBeenCalledTimes(1);
    });

    test("multi tenancy with redis", async () => {
      cds.requires.multitenancy = {};
      cds.requires["redis-eventQueue"].credentials = {
        hostname: "123",
      };
      const multiTenancyRedisSpy = jest.spyOn(runner, "multiTenancyRedis").mockResolvedValueOnce();
      jest.spyOn(redis, "connectionCheck").mockResolvedValueOnce(true);
      jest.spyOn(redis, "subscribeRedisChannel").mockResolvedValue();
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
        disableRedis: false,
        registerAsEventProcessor: true,
      });
      cds.emit("connect", await cds.connect.to("db"));
      await promisify(setImmediate)();
      expect(multiTenancyRedisSpy).toHaveBeenCalledTimes(1);
      cds.requires.multitenancy = null;
    });

    test("single tenant with redis", async () => {
      cds.requires["redis-eventQueue"].credentials = {
        hostname: "123",
      };
      const singleTenantRedisSpy = jest.spyOn(runner, "singleTenantRedis").mockResolvedValueOnce();
      jest.spyOn(redis, "connectionCheck").mockResolvedValueOnce(true);
      jest.spyOn(redis, "subscribeRedisChannel").mockResolvedValue();
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
        disableRedis: false,
        registerAsEventProcessor: true,
      });
      cds.emit("connect", await cds.connect.to("db"));
      await promisify(setImmediate)();
      expect(singleTenantRedisSpy).toHaveBeenCalledTimes(1);
      cds.requires.multitenancy = null;
    });

    test("multi tenancy with redis - option to disable redis", async () => {
      cds.requires.multitenancy = {};
      cds.requires["redis-eventQueue"].credentials = {
        hostname: "123",
      };
      const multiTenancyRedisSpy = jest.spyOn(runner, "multiTenancyRedis").mockResolvedValueOnce();
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
        disableRedis: true,
      });
      expect(multiTenancyRedisSpy).toHaveBeenCalledTimes(0);
      cds.requires.multitenancy = null;
    });

    test("mode none should not register any runner", async () => {
      const multiTenancyRedisSpy = jest.spyOn(runner, "multiTenancyRedis");
      const singleTenantDbSpy = jest.spyOn(runner, "singleTenantDb");
      const multiTenancyDbSpy = jest.spyOn(runner, "multiTenancyDb");
      const singleTenantRedis = jest.spyOn(runner, "singleTenantRedis");
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
        registerAsEventProcessor: false,
      });
      expect(multiTenancyRedisSpy).toHaveBeenCalledTimes(0);
      expect(singleTenantRedis).toHaveBeenCalledTimes(0);
      expect(singleTenantDbSpy).toHaveBeenCalledTimes(0);
      expect(multiTenancyDbSpy).toHaveBeenCalledTimes(0);
    });

    test("should mix init vars with env correctly", async () => {
      let envBefore = cds.env.eventQueue;
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
      cds.env.eventQueue = envBefore;
    });
  });

  describe("update periodic events", () => {
    beforeAll(() => {
      runner.__.setOffsetFirstRun(0);
    });

    it("single tenant - updatePeriodicEvents:true", async () => {
      const periodicEventsSpy = jest.spyOn(periodicEvents, "checkAndInsertPeriodicEvents").mockResolvedValueOnce();
      await eventQueue.initialize({
        configFilePath,
        registerAsEventProcessor: true,
        updatePeriodicEvents: true,
        isEventQueueActive: true,
      });
      cds.emit("connect", await cds.connect.to("db"));
      await promisify(setTimeout)(100);
      expect(periodicEventsSpy).toHaveBeenCalledTimes(1);
    });

    it("single tenant - updatePeriodicEvents:false", async () => {
      const periodicEventsSpy = jest.spyOn(periodicEvents, "checkAndInsertPeriodicEvents").mockResolvedValueOnce();
      await eventQueue.initialize({
        configFilePath,
        registerAsEventProcessor: true,
        updatePeriodicEvents: false,
      });
      cds.emit("connect", await cds.connect.to("db"));
      await promisify(setTimeout)(100);
      expect(periodicEventsSpy).toHaveBeenCalledTimes(0);
    });

    it("multi tenant db - updatePeriodicEvents:false", async () => {
      cds.requires.multitenancy = {};
      const periodicEventsSpy = jest.spyOn(periodicEvents, "checkAndInsertPeriodicEvents").mockResolvedValueOnce();
      jest.spyOn(cdsHelper, "getAllTenantIds").mockResolvedValueOnce([null]);
      await eventQueue.initialize({
        configFilePath,
        registerAsEventProcessor: true,
        updatePeriodicEvents: false,
      });
      cds.emit("connect", await cds.connect.to("db"));
      await promisify(setTimeout)(100);
      expect(periodicEventsSpy).toHaveBeenCalledTimes(0);
    });

    it("multi tenant db - updatePeriodicEvents:true", async () => {
      cds.requires.multitenancy = {};
      const periodicEventsSpy = jest.spyOn(periodicEvents, "checkAndInsertPeriodicEvents").mockResolvedValueOnce();
      jest.spyOn(cdsHelper, "getAllTenantIds").mockResolvedValueOnce([null]);
      await eventQueue.initialize({
        configFilePath,
        registerAsEventProcessor: true,
        updatePeriodicEvents: true,
        isEventQueueActive: true,
      });
      cds.emit("connect", await cds.connect.to("db"));
      await promisify(setTimeout)(100);
      expect(periodicEventsSpy).toHaveBeenCalledTimes(1);
    });

    afterAll(() => {
      runner.__.setOffsetFirstRun(10 * 1000);
    });
  });
});
