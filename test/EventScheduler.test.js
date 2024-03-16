"use strict";

const cds = require("@sap/cds");

const redisPub = require("../src/redis/redisPub");

const { getInstance: getEventSchedulerInstance } = require("../src/shared/eventScheduler");
const config = require("../src/config");

jest.mock("@sap/cds", () => ({
  log: jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
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
    jest.spyOn(config, "getEventConfig").mockReturnValue({
      interval: 60,
    });
    jest.spyOn(config, "isPeriodicEvent").mockReturnValue(false);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should schedule an event", () => {
    const broadcastEventSpy = jest.spyOn(redisPub, "broadcastEvent").mockResolvedValueOnce();
    jest.setSystemTime(new Date(1633046400000)); // 2021-10-01T00:00:00.000Z
    const startAfter = new Date("2021-10-01T00:00:01.000Z");
    eventScheduler.scheduleEvent("1", "type", "subType", startAfter);

    expect(cds.log().info).toHaveBeenCalledTimes(0);
    expect(cds.log().debug).toHaveBeenCalledTimes(1);
    expect(cds.log().debug.mock.calls[0]).toMatchSnapshot();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0][1]).toMatchInlineSnapshot(`10000`);
    expect(broadcastEventSpy).not.toHaveBeenCalled();
  });

  it("should not schedule an event if it's already scheduled", () => {
    const broadcastEventSpy = jest.spyOn(redisPub, "broadcastEvent");
    jest.setSystemTime(new Date(1633046400000)); // 2021-10-01T00:00:00.000Z

    const startAfter = new Date("2021-10-01T00:00:01.000Z");
    eventScheduler.scheduleEvent("1", "type", "subType", startAfter);
    eventScheduler.scheduleEvent("1", "type", "subType", startAfter);

    expect(cds.log().info).toHaveBeenCalledTimes(0);
    expect(cds.log().debug).toHaveBeenCalledTimes(1);
    expect(cds.log().error).toHaveBeenCalledTimes(0);
    expect(cds.log().debug.mock.calls[0]).toMatchSnapshot();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0][1]).toMatchInlineSnapshot(`10000`);
    expect(broadcastEventSpy).not.toHaveBeenCalled();
  });

  it("broadcastEvent should be correctly called", async () => {
    const broadcastEventSpy = jest.spyOn(redisPub, "broadcastEvent");
    setTimeoutSpy.mockRestore();
    setTimeoutSpy = jest.spyOn(global, "setTimeout");
    jest.setSystemTime(new Date(1633046400000)); // 2021-10-01T00:00:00.000Z
    const startAfter = new Date("2021-10-01T00:00:01.000Z");
    eventScheduler.scheduleEvent("1", "type", "subType", startAfter);

    expect(cds.log().info).toHaveBeenCalledTimes(0);
    expect(cds.log().debug).toHaveBeenCalledTimes(1);
    expect(cds.log().debug.mock.calls[0]).toMatchSnapshot();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0][1]).toMatchInlineSnapshot(`10000`);
    expect(broadcastEventSpy).not.toHaveBeenCalled();

    await jest.runAllTimersAsync();
    expect(broadcastEventSpy).toHaveBeenCalledTimes(1);
    expect(broadcastEventSpy.mock.calls[0]).toMatchInlineSnapshot(`
      [
        "1",
        {
          "subType": "subType",
          "type": "type",
        },
      ]
    `);
  });

  it("should handle an error when broadcasting an event", async () => {
    const broadcastEventSpy = jest
      .spyOn(redisPub, "broadcastEvent")
      .mockRejectedValueOnce(new Error("Broadcast failed"));
    setTimeoutSpy.mockRestore();
    setTimeoutSpy = jest.spyOn(global, "setTimeout");
    jest.setSystemTime(new Date(1633046400000)); // 2021-10-01T00:00:00.000Z
    const startAfter = new Date("2021-10-01T00:00:01.000Z");

    eventScheduler.scheduleEvent("1", "type", "subType", startAfter);
    await jest.runAllTimersAsync();

    expect(cds.log().info).toHaveBeenCalledTimes(0);
    expect(cds.log().debug).toHaveBeenCalledTimes(1);
    expect(cds.log().error).toHaveBeenCalledTimes(1);
    expect(cds.log().debug.mock.calls[0]).toMatchSnapshot();
    expect(cds.log().error.mock.calls[0]).toMatchSnapshot();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0][1]).toMatchInlineSnapshot(`10000`);
    expect(broadcastEventSpy).toHaveBeenCalledTimes(1);
    expect(broadcastEventSpy.mock.calls[0]).toMatchInlineSnapshot(`
      [
        "1",
        {
          "subType": "subType",
          "type": "type",
        },
      ]
    `);
  });
});
