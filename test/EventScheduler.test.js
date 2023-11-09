"use strict";

const cds = require("@sap/cds");

const EventScheduler = require("../src/shared/EventScheduler").getInstance;
const { broadcastEvent } = require("../src/redisPubSub");

jest.mock("@sap/cds", () => ({
  log: jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("../src/redisPubSub", () => ({
  broadcastEvent: jest.fn(),
}));

describe("EventScheduler", () => {
  let eventScheduler;
  let setTimeoutSpy;

  beforeEach(() => {
    eventScheduler.clearScheduledEvents();
  });

  beforeAll(() => {
    eventScheduler = EventScheduler();
    jest.useFakeTimers();
    setTimeoutSpy = jest.spyOn(global, "setTimeout").mockImplementation(() => {
      return {
        unref: () => {},
      };
    });
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
    expect(cds.log().info.mock.calls[0]).toMatchInlineSnapshot(`
      [
        "scheduling event queue run for delayed event",
        {
          "delaySeconds": 10,
          "subType": "subType",
          "type": "type",
        },
      ]
    `);
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
    expect(cds.log().info.mock.calls[0]).toMatchInlineSnapshot(`
      [
        "scheduling event queue run for delayed event",
        {
          "delaySeconds": 10,
          "subType": "subType",
          "type": "type",
        },
      ]
    `);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0][1]).toMatchInlineSnapshot(`10000`);
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it.skip("should handle an error when broadcasting an event", async () => {
    const dateNowStub = jest.fn(() => 1633029600000); // 2021-10-01T00:00:00.000Z
    global.Date.now = dateNowStub;

    const startAfter = new Date("2021-10-01T00:00:01.000Z");
    broadcastEvent.mockRejectedValue(new Error("Broadcast failed"));

    eventScheduler.scheduleEvent("1", "type", "subType", startAfter);

    await new Promise((r) => setTimeout(r, 2000)); // wait for the setTimeout to finish

    expect(cds.log).toHaveBeenCalled();
    expect(setTimeout).toHaveBeenCalled();
    expect(broadcastEvent).toHaveBeenCalled();
    expect(cds.error).toHaveBeenCalledWith(
      "could not execute scheduled event",
      expect.any(Error),
      expect.objectContaining({
        tenantId: "1",
        type: "type",
        subType: "subType",
        scheduledFor: expect.any(String),
      })
    );
  });
});
