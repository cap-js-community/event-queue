"use strict";

const cds = require("@sap/cds");

const redisPub = require("../src/redis/redisPub");
const { getInstance: getEventSchedulerInstance } = require("../src/shared/eventScheduler");

describe("EventScheduler context", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("scheduled processing does not inherit the context of the scheduling transaction", async () => {
    let contextInBroadcast;
    let resolveBroadcast;
    const broadcast = new Promise((resolve) => (resolveBroadcast = resolve));
    jest.spyOn(redisPub, "broadcastEvent").mockImplementation(async () => {
      contextInBroadcast = cds.context;
      resolveBroadcast();
    });

    let schedulingContextId;
    await cds.tx({ tenant: "t1" }, async () => {
      schedulingContextId = cds.context.id;
      getEventSchedulerInstance().scheduleEvent("t1", "Type", "SubType", "default", new Date(Date.now() + 50));
    });
    await broadcast;

    expect(contextInBroadcast).toBeInstanceOf(cds.EventContext);
    expect(Object.isSealed(contextInBroadcast._propagated)).toBe(true);
    expect(contextInBroadcast.id).not.toEqual(schedulingContextId);
    expect(contextInBroadcast.tenant).toEqual("t1");
  });
});
