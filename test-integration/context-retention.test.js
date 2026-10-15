"use strict";

const path = require("path");

const cds = require("@sap/cds");
cds.test(__dirname + "/_env");

const runner = require("../src/runner/runner");
jest.spyOn(runner, "singleTenantDb").mockResolvedValue();

const basePath = path.join(__dirname, "..", "test", "asset", "outboxProject");
cds.env.requires.ContextDepthService = {
  impl: path.join(basePath, "srv/service/context-depth-service.js"),
  queued: { kind: "persistent-queue", events: { tick: { cron: "*/15 * * * * *" } } },
};

const ContextDepthService = require(path.join(basePath, "srv/service/context-depth-service.js"));
const eventQueue = require("../src");
const periodicEvents = require("../src/periodicEvents");
const redisPub = require("../src/redis/redisPub");

describe("context retention of scheduled periodic events", () => {
  beforeAll(async () => {
    eventQueue.config.initialized = false;
    await eventQueue.initialize({
      processEventsAfterPublish: true,
      registerAsEventProcessor: true,
      useAsCAPOutbox: true,
      userId: "dummyTestUser",
      runInterval: 1500000,
    });
    cds.emit("connect", await cds.connect.to("db"));
    await cds.tx({}, async (tx) => {
      await tx.run(DELETE.from("sap.eventqueue.Lock"));
      await tx.run(DELETE.from("sap.eventqueue.Event"));
    });
  });

  afterAll(async () => {
    await cds.disconnect();
    await cds.shutdown();
  });

  it("the context does not grow with every tick of a periodic event", async () => {
    await cds.tx({}, (tx) => periodicEvents.checkAndInsertPeriodicEvents(tx.context));
    await redisPub.broadcastEvent(undefined, {
      type: "CAP_OUTBOX_PERIODIC",
      subType: "ContextDepthService.tick",
      namespace: "default",
    });

    const start = Date.now();
    while (ContextDepthService.contextDepths.length < 4 && Date.now() - start < 120 * 1000) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const [first, ...rest] = ContextDepthService.contextDepths;
    expect(rest).toHaveLength(3);
    expect(rest).toEqual(Array(3).fill(first));
  });
});
