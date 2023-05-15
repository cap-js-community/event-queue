"use strict";

const path = require("path");

const eventQueue = require("../src");

describe("initialize", () => {
  test("read yaml config file", async () => {
    const configFilePath = path.join(__dirname, "asset", "configFaulty.yml");
    await eventQueue.initialize({ configFilePath, registerDbHandler: false });
    const config = eventQueue.getConfigInstance().events;
    expect(config).toMatchSnapshot();
  });

  test("read yaml config file", async () => {
    const configFilePath = path.join(__dirname, "asset", "config.kk");
    await expect(
      eventQueue.initialize({ configFilePath, registerDbHandler: false })
    ).rejects.toThrow();
  });
});
