"use strict";

const path = require("path");

const cds = require("@sap/cds");
cds.test(__dirname + "/_env");

const basePath = path.join(__dirname, "..", "test", "asset", "outboxProject");
cds.env.requires.SagaParallel = {
  impl: path.join(basePath, "srv/service/saga-service.js"),
  queued: { kind: "persistent-queue", parallelEventProcessing: 3 },
};

cds.env.requires.SagaParallelLastAttempt = {
  impl: path.join(basePath, "srv/service/saga-service.js"),
  queued: { kind: "persistent-queue", parallelEventProcessing: 3, retryAttempts: 1, retryFailedAfter: 0 },
};

for (const transactionMode of ["alwaysCommit", "alwaysRollback"]) {
  cds.env.requires[`SagaParallel_${transactionMode}`] = {
    impl: path.join(basePath, "srv/service/saga-service.js"),
    queued: { kind: "persistent-queue", parallelEventProcessing: 3, transactionMode, checkForNextChunk: false },
  };
}

cds.env.requires.SagaSingle_alwaysRollback = {
  impl: path.join(basePath, "srv/service/saga-service.js"),
  queued: { kind: "persistent-queue", transactionMode: "alwaysRollback", checkForNextChunk: false },
};

cds.env.requires.SagaSingle_isolated = {
  impl: path.join(basePath, "srv/service/saga-service.js"),
  queued: { kind: "persistent-queue", checkForNextChunk: false },
};

const SagaService = require(path.join(basePath, "srv/service/saga-service.js"));
const eventQueue = require("../src");
const config = require("../src/config");
const { EventProcessingStatus } = require("../src/constants");
const { processEventQueue } = require("../src/processEventQueue");
const testHelper = require("../test/helper");
const { Logger: mockLogger } = require("../test/mocks/logger");

const eventName = (event) => JSON.parse(event.payload).event;
const triggerEventId = (event) => JSON.parse(JSON.parse(event.payload).data.triggerEvent).ID;
const followUpTriggerIds = (events, name) =>
  events
    .filter((event) => eventName(event) === name)
    .map(triggerEventId)
    .sort();

describe("saga follow-ups with parallel event processing", () => {
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
    cds.emit("connect", await cds.connect.to("db"));
    loggerMock = mockLogger();
  });

  beforeEach(async () => {
    context = new cds.EventContext({ user: "testUser" });
    tx = cds.tx(context);
    await cds.tx({}, async (tx2) => {
      await tx2.run(DELETE.from("sap.eventqueue.Lock"));
      await tx2.run(DELETE.from("sap.eventqueue.Event"));
    });
    await commitAndOpenNew();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    testHelper.restoreHoldPersist();
    SagaService.beforeSagaReturn = null;
    await tx.rollback();
  });

  afterAll(async () => {
    config.insertEventsBeforeCommit = true;
    await cds.disconnect();
    await cds.shutdown();
  });

  const sendSagaEvents = async (serviceName, dataFn, count = 3) => {
    const service = await cds.connect.to(serviceName);
    for (let n = 1; n <= count; n++) {
      await service.tx(context).send("saga", dataFn(n));
    }
    await commitAndOpenNew();
    const sent = await testHelper.selectEventQueueAndReturn(tx, {
      expectedLength: count,
      additionalColumns: ["ID", "payload"],
    });
    await commitAndOpenNew();
    const idOf = (n) => sent.find((event) => JSON.parse(event.payload).data.n === n).ID;
    return { service, idOf, ids: sent.map(({ ID }) => ID).sort() };
  };

  const processAndSelect = async (service, expectedLength) => {
    await processEventQueue(context, "CAP_OUTBOX", service.name);
    await commitAndOpenNew();
    const events = await testHelper.selectEventQueueAndReturn(tx, {
      expectedLength,
      additionalColumns: ["ID", "payload"],
    });
    await commitAndOpenNew();
    return events;
  };

  describe.each([true, false])("insertEventsBeforeCommit=%s", (insertEventsBeforeCommit) => {
    beforeAll(() => {
      config.insertEventsBeforeCommit = insertEventsBeforeCommit;
    });

    it("concurrent events without synchronisation insert their own follow-ups", async () => {
      const { service, ids } = await sendSagaEvents("SagaParallel", (n) => ({ n }), 9);

      const events = await processAndSelect(service, 27);

      const sagaEvents = events.filter((event) => eventName(event) === "saga");
      expect(sagaEvents.map(({ status }) => status)).toEqual(Array(9).fill(EventProcessingStatus.Done));
      expect(followUpTriggerIds(events, "saga/#succeeded")).toEqual(ids);
      expect(followUpTriggerIds(events, "saga/#done")).toEqual(ids);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("events persisting at the same time insert their own succeeded and done follow-ups", async () => {
      const { service, ids } = await sendSagaEvents("SagaParallel", (n) => ({ n }));
      testHelper.holdPersistUntilAllProcessed(3);

      const events = await processAndSelect(service, 9);

      const sagaEvents = events.filter((event) => eventName(event) === "saga");
      expect(sagaEvents.map(({ status }) => status)).toEqual(Array(3).fill(EventProcessingStatus.Done));
      expect(followUpTriggerIds(events, "saga/#succeeded")).toEqual(ids);
      expect(followUpTriggerIds(events, "saga/#done")).toEqual(ids);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("failed events persisting at the same time insert their own failed and done follow-ups", async () => {
      const { service, ids } = await sendSagaEvents("SagaParallel", (n) => ({
        n,
        status: EventProcessingStatus.Error,
        nextData: { n, status: EventProcessingStatus.Done },
      }));
      testHelper.holdPersistUntilAllProcessed(3);

      const events = await processAndSelect(service, 9);

      const sagaEvents = events.filter((event) => eventName(event) === "saga");
      expect(sagaEvents.map(({ status }) => status)).toEqual(Array(3).fill(EventProcessingStatus.Error));
      expect(followUpTriggerIds(events, "saga/#failed")).toEqual(ids);
      expect(followUpTriggerIds(events, "saga/#done")).toEqual(ids);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("a transaction failing after its writes is rolled back and only affects its own event", async () => {
      const { service, idOf } = await sendSagaEvents("SagaParallel", (n) => ({ n }));
      testHelper.holdPersistUntilAllProcessed(3, { failForId: idOf(2), failAfterPersist: true });

      const events = await processAndSelect(service, 9);

      const statusById = Object.fromEntries(events.map(({ ID, status }) => [ID, status]));
      expect(statusById[idOf(1)]).toEqual(EventProcessingStatus.Done);
      expect(statusById[idOf(2)]).toEqual(EventProcessingStatus.Error);
      expect(statusById[idOf(3)]).toEqual(EventProcessingStatus.Done);
      expect(followUpTriggerIds(events, "saga/#succeeded")).toEqual([idOf(1), idOf(3)].sort());
      expect(followUpTriggerIds(events, "saga/#failed")).toEqual([idOf(2)]);
      expect(followUpTriggerIds(events, "saga/#done")).toEqual([idOf(1), idOf(2), idOf(3)].sort());
    });

    describe.each(["alwaysCommit", "alwaysRollback"])("shared transaction - %s", (transactionMode) => {
      it.each([
        ["succeeded", (n) => ({ n })],
        ["failed", (n) => ({ n, status: EventProcessingStatus.Error, nextData: { n } })],
      ])("events finishing at the same time insert their own %s and done follow-ups", async (saga, dataFn) => {
        const { service, ids } = await sendSagaEvents(`SagaParallel_${transactionMode}`, dataFn);
        SagaService.beforeSagaReturn = testHelper.createBarrier(3);

        const events = await processAndSelect(service, 9);

        expect(followUpTriggerIds(events, `saga/#${saga}`)).toEqual(ids);
        expect(followUpTriggerIds(events, "saga/#done")).toEqual(ids);
        expect(loggerMock.callsLengths().error).toEqual(0);
      });
    });

    it("a single event in transaction mode alwaysRollback inserts its succeeded and done follow-ups", async () => {
      const { service, ids } = await sendSagaEvents("SagaSingle_alwaysRollback", (n) => ({ n }), 1);

      const events = await processAndSelect(service, 3);

      expect(followUpTriggerIds(events, "saga/#succeeded")).toEqual(ids);
      expect(followUpTriggerIds(events, "saga/#done")).toEqual(ids);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("a green event with a registered rollback inserts its succeeded and done follow-ups", async () => {
      const { service, ids } = await sendSagaEvents("SagaSingle_isolated", (n) => ({ n, rollback: true }), 1);

      const events = await processAndSelect(service, 3);

      expect(events.find(({ ID }) => ID === ids[0]).status).toEqual(EventProcessingStatus.Done);
      expect(followUpTriggerIds(events, "saga/#succeeded")).toEqual(ids);
      expect(followUpTriggerIds(events, "saga/#done")).toEqual(ids);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("a transaction failing in the last attempt still triggers failed", async () => {
      const { service, idOf } = await sendSagaEvents("SagaParallelLastAttempt", (n) => ({ n }));
      testHelper.holdPersistUntilAllProcessed(3, { failForId: idOf(2), failAfterPersist: true });

      let events = await processAndSelect(service, 9);
      testHelper.restoreHoldPersist();

      expect(events.find(({ ID }) => ID === idOf(2)).status).toEqual(EventProcessingStatus.Error);
      expect(followUpTriggerIds(events, "saga/#failed")).toEqual([idOf(2)]);

      events = await processAndSelect(service, 9);
      expect(events.find(({ ID }) => ID === idOf(2)).status).toEqual(EventProcessingStatus.Exceeded);
    });
  });

  const commitAndOpenNew = async () => {
    await tx.commit();
    context = new cds.EventContext({ user: "testUser" });
    tx = cds.tx(context);
  };
});
