"use strict";

const path = require("path");
const cdsHelper = require("../src/shared/cdsHelper");
const tenantIdsSpy = jest.spyOn(cdsHelper, "getAllTenantIds");

const eventQueue = require("../src");
const runner = require("../src/runner");

describe("initialize", () => {
  const configFilePath = path.join(__dirname, "asset", "configFaulty.yml");
  test("read yaml config file", async () => {
    tenantIdsSpy.mockResolvedValueOnce(null);
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
      tenantIdsSpy.mockResolvedValueOnce(null);
      const singleInstanceAndTenantSpy = jest
        .spyOn(runner, "singleInstanceAndTenant")
        .mockReturnValueOnce();
      await eventQueue.initialize({ configFilePath, registerDbHandler: false });
      expect(singleInstanceAndTenantSpy).toHaveBeenCalledTimes(1);
    });

    test("multi Instance, single tenant", async () => {
      tenantIdsSpy.mockResolvedValueOnce(null);
      const multiInstanceAndSingleTenancySpy = jest
        .spyOn(runner, "multiInstanceAndSingleTenancy")
        .mockReturnValueOnce();
      await eventQueue.initialize({
        configFilePath,
        registerDbHandler: false,
        mode: eventQueue.RunningModes.multiInstance,
      });
      expect(multiInstanceAndSingleTenancySpy).toHaveBeenCalledTimes(1);
    });

    test("single instance, multi tenant", async () => {
      tenantIdsSpy.mockResolvedValueOnce([]);
      const singleInstanceAndMultiTenancySpy = jest
        .spyOn(runner, "singleInstanceAndMultiTenancy")
        .mockReturnValueOnce();
      await eventQueue.initialize({ configFilePath, registerDbHandler: false });
      expect(singleInstanceAndMultiTenancySpy).toHaveBeenCalledTimes(1);
    });

    test("multi Instance, multi tenant", async () => {
      tenantIdsSpy.mockResolvedValueOnce([]);
      const multiInstanceAndTenancySoy = jest
        .spyOn(runner, "multiInstanceAndTenancy")
        .mockReturnValueOnce();
      await eventQueue.initialize({
        configFilePath,
        registerDbHandler: false,
        mode: eventQueue.RunningModes.multiInstance,
      });
      expect(multiInstanceAndTenancySoy).toHaveBeenCalledTimes(1);
    });
  });
});
