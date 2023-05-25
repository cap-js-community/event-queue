"use strict";

const path = require("path");

const redisPubSub = require("../src/redisPubSub");
jest.spyOn(redisPubSub, "initEventQueueRedisSubscribe").mockResolvedValue(null);

const eventQueue = require("../src");
const runner = require("../src/runner");
const cds = require("@sap/cds");

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
    test("single instance, single tenant", async () => {
      const singleInstanceAndTenantSpy = jest
        .spyOn(runner, "singleInstanceAndTenant")
        .mockReturnValueOnce();
      await eventQueue.initialize({ configFilePath, registerDbHandler: false });
      expect(singleInstanceAndTenantSpy).toHaveBeenCalledTimes(1);
    });

    test("multi Instance, single tenant", async () => {
      const multiInstanceAndSingleTenancySpy = jest
        .spyOn(runner, "multiInstanceAndSingleTenancy")
        .mockReturnValueOnce();
      eventQueue.getConfigInstance().isOnCF = true;
      process.env.VCAP_SERVICES = JSON.stringify({ "redis-cache": {} });
      await eventQueue.initialize({
        configFilePath,
        registerDbHandler: false,
        mode: eventQueue.RunningModes.multiInstance,
      });
      expect(multiInstanceAndSingleTenancySpy).toHaveBeenCalledTimes(1);
    });

    test("single instance, multi tenant", async () => {
      cds.requires.multitenancy = {};
      const singleInstanceAndMultiTenancySpy = jest
        .spyOn(runner, "singleInstanceAndMultiTenancy")
        .mockReturnValueOnce();
      await eventQueue.initialize({ configFilePath, registerDbHandler: false });
      expect(singleInstanceAndMultiTenancySpy).toHaveBeenCalledTimes(1);
      cds.requires.multitenancy = null;
    });

    test("calling initialize twice should only processed once", async () => {
      const singleInstanceAndTenant = jest
        .spyOn(runner, "singleInstanceAndTenant")
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
      expect(singleInstanceAndTenant).toHaveBeenCalledTimes(1);
    });

    test("multi Instance, multi tenant", async () => {
      cds.requires.multitenancy = {};
      const multiInstanceAndTenancySpy = jest
        .spyOn(runner, "multiInstanceAndTenancy")
        .mockReturnValueOnce();
      await eventQueue.initialize({
        configFilePath,
        registerDbHandler: false,
        mode: eventQueue.RunningModes.multiInstance,
      });
      expect(multiInstanceAndTenancySpy).toHaveBeenCalledTimes(1);
      cds.requires.multitenancy = null;
    });

    test("mode none should not register any runner", async () => {
      const multiInstanceAndTenancySpy = jest.spyOn(
        runner,
        "multiInstanceAndTenancy"
      );
      const singleInstanceAndTenantSpy = jest.spyOn(
        runner,
        "singleInstanceAndTenant"
      );
      const singleInstanceAndMultiTenancySpy = jest.spyOn(
        runner,
        "singleInstanceAndMultiTenancy"
      );
      const multiInstanceAndSingleTenancySpy = jest.spyOn(
        runner,
        "multiInstanceAndSingleTenancy"
      );
      await eventQueue.initialize({
        configFilePath,
        registerDbHandler: false,
        mode: eventQueue.RunningModes.none,
      });
      expect(multiInstanceAndTenancySpy).toHaveBeenCalledTimes(0);
      expect(singleInstanceAndTenantSpy).toHaveBeenCalledTimes(0);
      expect(singleInstanceAndMultiTenancySpy).toHaveBeenCalledTimes(0);
      expect(multiInstanceAndSingleTenancySpy).toHaveBeenCalledTimes(0);
    });
  });
});
