"use strict";

const path = require("path");

const mockRedis = require("../test/mocks/redisMock");
jest.mock("../src/shared/redis", () => mockRedis);

const cds = require("@sap/cds");
cds.test(__dirname + "/_env");

const basePath = path.join(__dirname, "..", "test", "asset", "outboxProject");
cds.env.requires.StandardService = {
  impl: path.join(basePath, "srv/service/standard-service.js"),
  outbox: { kind: "persistent-outbox" },
};

cds.env.requires.NotificationService = {
  impl: path.join(basePath, "srv/service/service.js"),
  outbox: { kind: "persistent-outbox" },
};

const eventQueue = require("../src");
const config = require("../src/config");
const { getTenantStats, getGlobalStats, StatusField } = require("../src/shared/eventQueueStats");
const { EventProcessingStatus } = require("../src/constants");
const { processEventQueue } = require("../src/processEventQueue");
const testHelper = require("../test/helper");
const { Logger: mockLogger } = require("../test/mocks/logger");

describe("dbHandler - stats tracking on HANA", () => {
  let context, tx, loggerMock;

  beforeAll(async () => {
    eventQueue.config.initialized = false;
    await eventQueue.initialize({
      processEventsAfterPublish: false,
      registerAsEventProcessor: false,
      insertEventsBeforeCommit: true,
      useAsCAPOutbox: true,
      userId: "dummyTestUser",
    });
    const db = await cds.connect.to("db");
    cds.emit("connect", db);
    config.redisEnabled = true;
    eventQueue.registerEventQueueDbHandler(db);
    loggerMock = mockLogger();
  });

  beforeEach(async () => {
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
    await cds.tx({}, async (tx2) => {
      await tx2.run(DELETE.from("sap.eventqueue.Lock"));
      await tx2.run(DELETE.from("sap.eventqueue.Event"));
    });
    await commitAndOpenNew();
    mockRedis.clearState();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await tx.rollback();
  });

  afterAll(async () => {
    config.redisEnabled = false;
    await cds.disconnect();
    await cds.shutdown();
  });

  it("increments pending counter by 1 after single send and commit", async () => {
    const service = (await cds.connect.to("StandardService")).tx(context);
    await service.send("main", {});
    await commitAndOpenNew();

    const tenantStats = await getTenantStats(123);
    expect(tenantStats[StatusField.Pending]).toBe(1);

    const globalStats = await getGlobalStats();
    expect(globalStats[StatusField.Pending]).toBe(1);

    expect(loggerMock.callsLengths().error).toBe(0);
  });

  it("accumulates pending counter for multiple sends in same transaction", async () => {
    const service = (await cds.connect.to("StandardService")).tx(context);
    await service.send("main", {});
    await service.send("main", {});
    await service.send("main", {});
    await commitAndOpenNew();

    const tenantStats = await getTenantStats(123);
    expect(tenantStats[StatusField.Pending]).toBe(3);

    const globalStats = await getGlobalStats();
    expect(globalStats[StatusField.Pending]).toBe(3);

    expect(loggerMock.callsLengths().error).toBe(0);
  });

  it("does not increment counter when transaction is rolled back", async () => {
    const innerTx = cds.tx(context);
    const service = (await cds.connect.to("StandardService")).tx(innerTx.context);
    await service.send("main", {});
    await innerTx.rollback();

    const tenantStats = await getTenantStats(123);
    expect(tenantStats[StatusField.Pending]).toBe(0);

    const globalStats = await getGlobalStats();
    expect(globalStats[StatusField.Pending]).toBe(0);
  });

  it("does not increment counter when redisEnabled is false", async () => {
    config.redisEnabled = false;
    try {
      const service = (await cds.connect.to("StandardService")).tx(context);
      await service.send("main", {});
      await commitAndOpenNew();

      const tenantStats = await getTenantStats(123);
      expect(tenantStats[StatusField.Pending]).toBe(0);

      const globalStats = await getGlobalStats();
      expect(globalStats[StatusField.Pending]).toBe(0);
    } finally {
      config.redisEnabled = true;
    }
  });

  it("tracks stats per tenant while global counter aggregates", async () => {
    const service123 = (await cds.connect.to("StandardService")).tx(context);
    await service123.send("main", {});
    await service123.send("main", {});
    await commitAndOpenNew();

    const ctx456 = new cds.EventContext({ user: "testUser", tenant: 456 });
    const tx456 = cds.tx(ctx456);
    const service456 = (await cds.connect.to("StandardService")).tx(ctx456);
    await service456.send("main", {});
    await tx456.commit();

    const stats123 = await getTenantStats(123);
    expect(stats123[StatusField.Pending]).toBe(2);

    const stats456 = await getTenantStats(456);
    expect(stats456[StatusField.Pending]).toBe(1);

    const globalStats = await getGlobalStats();
    expect(globalStats[StatusField.Pending]).toBe(3);

    expect(loggerMock.callsLengths().error).toBe(0);
  });

  describe("UPDATE handler — HANA affectedRows behavior", () => {
    it("Open → InProgress: HANA affectedRows returns correct count for bulk update of 3 rows", async () => {
      const service = (await cds.connect.to("StandardService")).tx(context);
      await service.send("main", {});
      await service.send("main", {});
      await service.send("main", {});
      await commitAndOpenNew(); // pending=3

      await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ status: EventProcessingStatus.InProgress }));
      await commitAndOpenNew();

      // On HANA, affectedRows must be 3 — not the fallback of 1
      const tenantStats = await getTenantStats(123);
      expect(tenantStats[StatusField.Pending]).toBe(0);
      expect(tenantStats[StatusField.InProgress]).toBe(3);

      const globalStats = await getGlobalStats();
      expect(globalStats[StatusField.Pending]).toBe(0);
      expect(globalStats[StatusField.InProgress]).toBe(3);

      expect(loggerMock.callsLengths().error).toBe(0);
    });

    it("InProgress → Done: HANA affectedRows correctly decrements all inProgress", async () => {
      const service = (await cds.connect.to("StandardService")).tx(context);
      await service.send("main", {});
      await service.send("main", {});
      await service.send("main", {});
      await commitAndOpenNew(); // pending=3

      await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ status: EventProcessingStatus.InProgress }));
      await commitAndOpenNew(); // pending=0, inProgress=3

      await tx.run(
        UPDATE.entity("sap.eventqueue.Event")
          .set({ status: EventProcessingStatus.Done })
          .where({ status: EventProcessingStatus.InProgress })
      );
      await commitAndOpenNew();

      const tenantStats = await getTenantStats(123);
      expect(tenantStats[StatusField.Pending]).toBe(0);
      expect(tenantStats[StatusField.InProgress]).toBe(0);

      expect(loggerMock.callsLengths().error).toBe(0);
    });

    it("InProgress → Error: HANA affectedRows correctly restores all rows as pending", async () => {
      const service = (await cds.connect.to("StandardService")).tx(context);
      await service.send("main", {});
      await service.send("main", {});
      await service.send("main", {});
      await commitAndOpenNew(); // pending=3

      await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ status: EventProcessingStatus.InProgress }));
      await commitAndOpenNew(); // pending=0, inProgress=3

      await tx.run(
        UPDATE.entity("sap.eventqueue.Event")
          .set({ status: EventProcessingStatus.Error })
          .where({ status: EventProcessingStatus.InProgress })
      );
      await commitAndOpenNew();

      const tenantStats = await getTenantStats(123);
      expect(tenantStats[StatusField.Pending]).toBe(3);
      expect(tenantStats[StatusField.InProgress]).toBe(0);

      const globalStats = await getGlobalStats();
      expect(globalStats[StatusField.Pending]).toBe(3);
      expect(globalStats[StatusField.InProgress]).toBe(0);

      expect(loggerMock.callsLengths().error).toBe(0);
    });

    it("InProgress → Exceeded: HANA affectedRows correctly decrements all inProgress", async () => {
      const service = (await cds.connect.to("StandardService")).tx(context);
      await service.send("main", {});
      await service.send("main", {});
      await service.send("main", {});
      await commitAndOpenNew(); // pending=3

      await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ status: EventProcessingStatus.InProgress }));
      await commitAndOpenNew(); // pending=0, inProgress=3

      await tx.run(
        UPDATE.entity("sap.eventqueue.Event")
          .set({ status: EventProcessingStatus.Exceeded })
          .where({ status: EventProcessingStatus.InProgress })
      );
      await commitAndOpenNew();

      const tenantStats = await getTenantStats(123);
      expect(tenantStats[StatusField.Pending]).toBe(0);
      expect(tenantStats[StatusField.InProgress]).toBe(0);

      expect(loggerMock.callsLengths().error).toBe(0);
    });

    it("UPDATE matching 0 rows does not affect counters", async () => {
      const service = (await cds.connect.to("StandardService")).tx(context);
      await service.send("main", {});
      await commitAndOpenNew(); // pending=1

      // WHERE clause matches nothing — affectedRows=0, must not change counters
      await tx.run(
        UPDATE.entity("sap.eventqueue.Event")
          .set({ status: EventProcessingStatus.Done })
          .where({ status: EventProcessingStatus.InProgress }) // nothing is InProgress yet
      );
      await commitAndOpenNew();

      const tenantStats = await getTenantStats(123);
      expect(tenantStats[StatusField.Pending]).toBe(1);
      expect(tenantStats[StatusField.InProgress]).toBe(0);

      expect(loggerMock.callsLengths().error).toBe(0);
    });

    it("two UPDATEs in one transaction accumulate into a single succeeded handler call", async () => {
      const service = (await cds.connect.to("StandardService")).tx(context);
      await service.send("main", {});
      await service.send("main", {});
      await commitAndOpenNew(); // pending=2

      // Open→InProgress then InProgress→Done without an intermediate commit
      await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ status: EventProcessingStatus.InProgress }));
      await tx.run(
        UPDATE.entity("sap.eventqueue.Event")
          .set({ status: EventProcessingStatus.Done })
          .where({ status: EventProcessingStatus.InProgress })
      );
      await commitAndOpenNew();

      // Net delta: pending -2, inProgress +2 then -2 → both counters at 0
      const tenantStats = await getTenantStats(123);
      expect(tenantStats[StatusField.Pending]).toBe(0);
      expect(tenantStats[StatusField.InProgress]).toBe(0);

      expect(loggerMock.callsLengths().error).toBe(0);
    });

    it("does not adjust counters when redisEnabled is false", async () => {
      const service = (await cds.connect.to("StandardService")).tx(context);
      await service.send("main", {});
      await service.send("main", {});
      await commitAndOpenNew(); // pending=2

      config.redisEnabled = false;
      try {
        await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ status: EventProcessingStatus.InProgress }));
        await commitAndOpenNew();

        const tenantStats = await getTenantStats(123);
        expect(tenantStats[StatusField.Pending]).toBe(2);
        expect(tenantStats[StatusField.InProgress]).toBe(0);
      } finally {
        config.redisEnabled = true;
      }
    });

    it("does not adjust counters when transaction is rolled back", async () => {
      const service = (await cds.connect.to("StandardService")).tx(context);
      await service.send("main", {});
      await service.send("main", {});
      await commitAndOpenNew(); // pending=2

      const innerTx = cds.tx(context);
      await innerTx.run(UPDATE.entity("sap.eventqueue.Event").set({ status: EventProcessingStatus.InProgress }));
      await innerTx.rollback();

      const tenantStats = await getTenantStats(123);
      expect(tenantStats[StatusField.Pending]).toBe(2);
      expect(tenantStats[StatusField.InProgress]).toBe(0);
    });
  });

  describe("processEventQueue integration — stats via real processing", () => {
    it("successful processing transitions pending → inProgress → Done (counters reach zero)", async () => {
      const service = (await cds.connect.to("StandardService")).tx(context);
      await service.send("main", {});
      await commitAndOpenNew();

      expect((await getTenantStats(123))[StatusField.Pending]).toBe(1);
      expect((await getTenantStats(123))[StatusField.InProgress]).toBe(0);

      await processEventQueue(tx.context, "CAP_OUTBOX", "StandardService");
      await commitAndOpenNew();

      const tenantStats = await getTenantStats(123);
      expect(tenantStats[StatusField.Pending]).toBe(0);
      expect(tenantStats[StatusField.InProgress]).toBe(0);

      const globalStats = await getGlobalStats();
      expect(globalStats[StatusField.Pending]).toBe(0);
      expect(globalStats[StatusField.InProgress]).toBe(0);

      await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
    });

    it("failed processing transitions pending → inProgress → Error → back to pending", async () => {
      const service = cds.outboxed(await cds.connect.to("NotificationService")).tx(context);
      await service.send("errorEvent", { to: "to", subject: "subject", body: "body" });
      await commitAndOpenNew();

      expect((await getTenantStats(123))[StatusField.Pending]).toBe(1);
      expect((await getTenantStats(123))[StatusField.InProgress]).toBe(0);

      await processEventQueue(tx.context, "CAP_OUTBOX", "NotificationService");
      await commitAndOpenNew();

      // Error state means the event will be retried → counts as pending
      const tenantStats = await getTenantStats(123);
      expect(tenantStats[StatusField.Pending]).toBe(1);
      expect(tenantStats[StatusField.InProgress]).toBe(0);

      const globalStats = await getGlobalStats();
      expect(globalStats[StatusField.Pending]).toBe(1);
      expect(globalStats[StatusField.InProgress]).toBe(0);

      await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
    });
  });

  const commitAndOpenNew = async () => {
    await tx.commit();
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
  };
});
