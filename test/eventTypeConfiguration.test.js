"use strict";

const path = require("path");

const eventQueue = require("../src");

describe("eventTypeConfiguration", () => {
  test("start", async () => {
    const configFilePath = path.join(__dirname, "asset", "config.yml");
    await eventQueue.initialize({ configFilePath, registerDbHandler: false });
    const test = eventQueue.getAllEvents();
    debugger;
  });
});
