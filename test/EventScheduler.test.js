"use strict";

const cds = require("@sap/cds");

const { getInstance: getEventSchedulerInstance } = require("../src/shared/EventScheduler");
const { getConfigInstance } = require("../src/config");
const { broadcastEvent } = require("../src/redisPubSub");

jest.mock("@sap/cds", () => ({
  log: jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("../src/redisPubSub", () => ({
  broadcastEvent: jest.fn().mockResolvedValue(),
}));

describe("EventScheduler", () => {
  let eventScheduler;
  let setTimeoutSpy;

  beforeEach(() => {
    eventScheduler.clearScheduledEvents();
    setTimeoutSpy = jest.spyOn(global, "setTimeout").mockImplementation(() => {
      return {
        unref: () => {},
      };
    });
  });

  beforeAll(() => {
    eventScheduler = getEventSchedulerInstance();
    const configInstance = getConfigInstance();
    jest.spyOn(configInstance, "getEventConfig").mockReturnValue({
      interval: 60,
    });
    jest.spyOn(configInstance, "isPeriodicEvent").mockReturnValue(false);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should schedule an event", () => {
    jest.setSystemTime(new Date(1633046400000)); // 2021-10-01T00:00:00.000Z
    const startAfter = new Date("2021-10-01T00:00:01.000Z");
    eventScheduler.scheduleEvent("1", "type", "subType", startAfter);

    expect(cds.log().info).toHaveBeenCalledTimes(1);
    expect(cds.log().error).toHaveBeenCalledTimes(0);
    expect(cds.log().info.mock.calls[0]).toMatchSnapshot();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0][1]).toMatchInlineSnapshot(`10000`);
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it("should not schedule an event if it's already scheduled", () => {
    jest.setSystemTime(new Date(1633046400000)); // 2021-10-01T00:00:00.000Z

    const startAfter = new Date("2021-10-01T00:00:01.000Z");
    eventScheduler.scheduleEvent("1", "type", "subType", startAfter);
    eventScheduler.scheduleEvent("1", "type", "subType", startAfter);

    expect(cds.log().info).toHaveBeenCalledTimes(1);
    expect(cds.log().error).toHaveBeenCalledTimes(0);
    expect(cds.log().info.mock.calls[0]).toMatchSnapshot();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0][1]).toMatchInlineSnapshot(`10000`);
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it("broadcastEvent should be correctly called", async () => {
    setTimeoutSpy.mockRestore();
    setTimeoutSpy = jest.spyOn(global, "setTimeout");
    jest.setSystemTime(new Date(1633046400000)); // 2021-10-01T00:00:00.000Z
    const startAfter = new Date("2021-10-01T00:00:01.000Z");
    eventScheduler.scheduleEvent("1", "type", "subType", startAfter);

    expect(cds.log().info).toHaveBeenCalledTimes(1);
    expect(cds.log().error).toHaveBeenCalledTimes(0);
    expect(cds.log().info.mock.calls[0]).toMatchSnapshot();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0][1]).toMatchInlineSnapshot(`10000`);
    expect(broadcastEvent).not.toHaveBeenCalled();

    await jest.runAllTimersAsync();
    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    expect(broadcastEvent.mock.calls[0]).toMatchInlineSnapshot(`
      [
        "1",
        "type",
        "subType",
      ]
    `);
  });

  it("should handle an error when broadcasting an event", async () => {
    setTimeoutSpy.mockRestore();
    setTimeoutSpy = jest.spyOn(global, "setTimeout");
    jest.setSystemTime(new Date(1633046400000)); // 2021-10-01T00:00:00.000Z
    const startAfter = new Date("2021-10-01T00:00:01.000Z");
    broadcastEvent.mockRejectedValueOnce(new Error("Broadcast failed"));

    eventScheduler.scheduleEvent("1", "type", "subType", startAfter);
    await jest.runAllTimersAsync();

    expect(cds.log().info).toHaveBeenCalledTimes(1);
    expect(cds.log().error).toHaveBeenCalledTimes(1);
    expect(cds.log().info.mock.calls[0]).toMatchSnapshot();
    expect(cds.log().error.mock.calls[0]).toMatchSnapshot();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0][1]).toMatchInlineSnapshot(`10000`);
    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    expect(broadcastEvent.mock.calls[0]).toMatchInlineSnapshot(`
      [
        "1",
        "type",
        "subType",
      ]
    `);
  });
});
