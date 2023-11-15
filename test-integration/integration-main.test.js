"use strict";

const path = require("path");
const { promisify } = require("util");

const cds = require("@sap/cds");
cds.test(__dirname + "/_env");
const cdsHelper = require("../src/shared/cdsHelper");
jest.spyOn(cdsHelper, "getAllTenantIds").mockResolvedValue(null);

const eventQueue = require("../src");
const testHelper = require("../test/helper");
const EventQueueTest = require("../test/asset/EventQueueTest");
const { EventProcessingStatus, EventQueueProcessorBase } = require("../src");
const { Logger: mockLogger } = require("../test/mocks/logger");
const distributedLock = require("../src/shared/distributedLock");
const eventScheduler = require("../src/shared/eventScheduler");
const { processEventQueue } = require("../src/processEventQueue");
const periodicEvents = require("../src/periodicEvents");

let dbCounts = {};
describe("integration-main", () => {
  let context;
  let tx;
  let loggerMock;
  let checkAndInsertPeriodicEventsMock;

  beforeAll(async () => {
    const configFilePath = path.join(__dirname, "..", "./test", "asset", "config.yml");
    checkAndInsertPeriodicEventsMock = jest.spyOn(periodicEvents, "checkAndInsertPeriodicEvents").mockResolvedValue();
    await eventQueue.initialize({
      configFilePath,
      processEventsAfterPublish: false,
      registerAsEventProcessor: false,
    });
    loggerMock = mockLogger();
    jest.spyOn(cds, "log").mockImplementation((layer) => {
      return mockLogger(layer);
    });
    const db = await cds.connect.to("db");
    db.before("*", (cdsContext) => {
      if (dbCounts[cdsContext.event]) {
        dbCounts[cdsContext.event] = dbCounts[cdsContext.event] + 1;
      } else {
        dbCounts[cdsContext.event] = 1;
      }
    });
  });

  beforeEach(async () => {
    context = new cds.EventContext({});
    tx = cds.tx(context);
    await cds.tx({}, async (tx2) => {
      await tx2.run(DELETE.from("sap.eventqueue.Lock"));
      await tx2.run(DELETE.from("sap.eventqueue.Event"));
    });
    dbCounts = {};
  });

  afterEach(async () => {
    await tx.rollback();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await cds.disconnect();
    await cds.shutdown();
  });

  it("empty queue - nothing to do", async () => {
    const event = eventQueue.config.events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    await testHelper.selectEventQueueAndExpectDone(tx, 0);
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(dbCounts).toMatchSnapshot();
  });

  it("insert one entry and process", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    dbCounts = {};
    const event = eventQueue.config.events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectDone(tx);
    expect(dbCounts).toMatchSnapshot();
  });

  it("insert one delayed entry and process - should not be processed", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2, { delayedSeconds: 15 }));
    dbCounts = {};
    const event = eventQueue.config.events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectOpen(tx);
    expect(dbCounts).toMatchSnapshot();
  });

  it("if process event returns an error --> tx should be rolled backed", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    dbCounts = {};
    const event = eventQueue.config.events[0];
    jest
      .spyOn(EventQueueTest.prototype, "processEvent")
      .mockImplementationOnce(async (processContext, key, queueEntries) => {
        await cds.tx(processContext).run(SELECT.from("sap.eventqueue.Lock"));
        return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Error]);
      });
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectError(tx);
    expect(dbCounts).toMatchSnapshot();
  });

  it("if process event throws an error --> tx should be rolled backed", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    dbCounts = {};
    const event = eventQueue.config.events[0];
    jest.spyOn(EventQueueTest.prototype, "processEvent").mockImplementationOnce(async (processContext) => {
      await cds.tx(processContext).run(SELECT.from("sap.eventqueue.Lock"));
      throw new Error("error during processing");
    });
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(1);
    expect(loggerMock.calls().error[0][1]).toMatchInlineSnapshot(`[Error: error during processing]`);
    await testHelper.selectEventQueueAndExpectError(tx);
    expect(dbCounts).toMatchSnapshot();
  });

  it("if cluster methods throws an error --> entry should not be processed + status should be error", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    dbCounts = {};
    const event = eventQueue.config.events[0];
    jest.spyOn(EventQueueTest.prototype, "clusterQueueEntries").mockImplementationOnce(() => {
      throw new Error("error during processing");
    });
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(1);
    expect(loggerMock.calls().error[0][1]).toMatchInlineSnapshot(`[Error: error during processing]`);
    expect(loggerMock.calls().error).toMatchSnapshot();
    await testHelper.selectEventQueueAndExpectError(tx);
    expect(dbCounts).toMatchSnapshot();
  });

  it("if checkEventAndGeneratePayload methods throws an error --> entry should not be processed + status should be error", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    dbCounts = {};
    const event = eventQueue.config.events[0];
    jest.spyOn(EventQueueTest.prototype, "checkEventAndGeneratePayload").mockImplementationOnce(() => {
      throw new Error("error during processing");
    });
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(1);
    expect(loggerMock.calls().error).toMatchSnapshot();
    await testHelper.selectEventQueueAndExpectError(tx);
    expect(dbCounts).toMatchSnapshot();
  });

  it("if modifyQueueEntry methods throws an error --> entry should not be processed + status should be error", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    dbCounts = {};
    const event = eventQueue.config.events[0];
    jest.spyOn(EventQueueTest.prototype, "modifyQueueEntry").mockImplementationOnce(() => {
      throw new Error("error during processing");
    });
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(1);
    // TODO: should not be an unexpected error
    expect(loggerMock.calls().error).toMatchSnapshot();
    await testHelper.selectEventQueueAndExpectError(tx);
    expect(dbCounts).toMatchSnapshot();
  });

  it("two entries with no commit on event level", async () => {
    await cds.tx({}, (tx2) =>
      testHelper.insertEventEntry(tx2, {
        numberOfEntries: 2,
        type: "TransactionMode",
        subType: "alwaysRollback",
      })
    );
    dbCounts = {};
    await eventQueue.processEventQueue(context, "TransactionMode", "alwaysRollback");
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectDone(tx, 2);
    expect(dbCounts).toMatchSnapshot();
  });

  it("returning exceeded status should be allowed", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    const processSpy = jest
      .spyOn(EventQueueTest.prototype, "processEvent")
      .mockImplementationOnce((processContext, key, queueEntries) => {
        return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Exceeded]);
      });
    dbCounts = {};
    const event = eventQueue.config.events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectExceeded(tx, 1);
    expect(dbCounts).toMatchSnapshot();
    dbCounts = {};
    expect(processSpy).toHaveBeenCalledTimes(1);

    // Event should not be processed anymore
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectExceeded(tx, 1);
    expect(dbCounts).toMatchSnapshot();
    expect(processSpy).toHaveBeenCalledTimes(1);
  });

  it("should do nothing if lock for event combination cannot be acquired", async () => {
    const event = eventQueue.config.events[0];
    await cds.tx({}, async (tx2) => {
      await testHelper.insertEventEntry(tx2);
      await distributedLock.acquireLock(tx2.context, [event.type, event.subType].join("##"));
    });
    dbCounts = {};
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectOpen(tx, 1);
    expect(dbCounts).toMatchSnapshot();
  });

  it("should delete event entries after 30 days", async () => {
    await cds.tx({}, async (tx2) => {
      const event = testHelper.getEventEntry();
      event.lastAttemptTimestamp = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      event.status = eventQueue.EventProcessingStatus.Done;
      await eventQueue.publishEvent(tx2, event);
    });
    dbCounts = {};
    const event = eventQueue.config.events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectDone(tx, 0);
    expect(dbCounts).toMatchSnapshot();
  });

  it("lock wait timeout during keepAlive", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    dbCounts = {};
    const event = eventQueue.config.events[0];

    const db = await cds.connect.to("db");
    let doCheck = true;
    db.prepend(() => {
      db.on("READ", "*", async (context, next) => {
        if (doCheck && context.query.SELECT.forUpdate && context.query.SELECT.columns.length === 2) {
          throw new Error("all bad");
        }
        return await next();
      });
    });
    await eventQueue.processEventQueue(context, event.type, event.subType);
    doCheck = false;
    expect(loggerMock.callsLengths().error).toEqual(1);
    await testHelper.selectEventQueueAndExpectError(tx);
    expect(dbCounts).toMatchSnapshot();
  });

  describe("transactionMode=isolated", () => {
    it("first processed register tx rollback - only first should be rolled back", async () => {
      await cds.tx({}, (tx2) =>
        testHelper.insertEventEntry(tx2, {
          numberOfEntries: 2,
          type: "TransactionMode",
          subType: "isolated",
        })
      );
      dbCounts = {};
      jest
        .spyOn(EventQueueTest.prototype, "processEvent")
        .mockImplementationOnce(async function (processContext, key, queueEntries) {
          this.setShouldRollbackTransaction(key);
          await testHelper.insertEventEntry(cds.tx(processContext), {
            numberOfEntries: 1,
            type: "TransactionMode",
            subType: "alwaysRollback",
            randomGuid: true,
          });
          return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
        })
        .mockImplementationOnce(async function (processContext, key, queueEntries) {
          await testHelper.insertEventEntry(cds.tx(processContext), {
            numberOfEntries: 1,
            type: "TransactionMode",
            subType: "alwaysRollback",
            randomGuid: true,
          });
          return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
        });
      await eventQueue.processEventQueue(context, "TransactionMode", "isolated");
      expect(loggerMock.callsLengths().error).toEqual(0);
      const events = await testHelper.selectEventQueueAndReturn(tx, 3);
      expect(events).toMatchSnapshot();
      expect(dbCounts).toMatchSnapshot();
    });

    it("both processed register tx rollback - both should be roll back", async () => {
      await cds.tx({}, (tx2) =>
        testHelper.insertEventEntry(tx2, {
          numberOfEntries: 2,
          type: "TransactionMode",
          subType: "isolated",
        })
      );
      dbCounts = {};
      jest
        .spyOn(EventQueueTest.prototype, "processEvent")
        .mockImplementationOnce(async function (processContext, key, queueEntries) {
          this.setShouldRollbackTransaction(key);
          await testHelper.insertEventEntry(cds.tx(processContext), {
            numberOfEntries: 1,
            type: "TransactionMode",
            subType: "alwaysRollback",
            randomGuid: true,
          });
          return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
        })
        .mockImplementationOnce(async function (processContext, key, queueEntries) {
          this.setShouldRollbackTransaction(key);
          await testHelper.insertEventEntry(cds.tx(processContext), {
            numberOfEntries: 1,
            type: "TransactionMode",
            subType: "alwaysRollback",
            randomGuid: true,
          });
          return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
        });
      await eventQueue.processEventQueue(context, "TransactionMode", "isolated");
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectDone(tx, 2);
      expect(dbCounts).toMatchSnapshot();
    });
  });

  describe("transactionMode=alwaysCommit", () => {
    it("one with error + one without error --> tx no rollback because mode alwaysCommit", async () => {
      await cds.tx({}, (tx2) =>
        testHelper.insertEventEntry(tx2, {
          numberOfEntries: 2,
          type: "TransactionMode",
          subType: "alwaysCommit",
        })
      );
      dbCounts = {};
      jest.spyOn(EventQueueTest.prototype, "processEvent").mockImplementationOnce(async (processContext) => {
        await testHelper.insertEventEntry(cds.tx(processContext), {
          numberOfEntries: 1,
          type: "TransactionMode",
          subType: "alwaysRollback",
          randomGuid: true,
        });
        throw new Error("error during processing");
      });
      await eventQueue.processEventQueue(context, "TransactionMode", "alwaysCommit");
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error[0][1]).toMatchInlineSnapshot(`[Error: error during processing]`);
      expect(dbCounts).toMatchSnapshot();
      const events = await testHelper.selectEventQueueAndReturn(tx, 3);
      expect(events).toMatchSnapshot();
    });

    it("one green with register rollback in processEvent --> tx rollback even mode alwaysCommit", async () => {
      await cds.tx({}, (tx2) =>
        testHelper.insertEventEntry(tx2, {
          numberOfEntries: 1,
          type: "TransactionMode",
          subType: "alwaysCommit",
        })
      );
      dbCounts = {};
      jest
        .spyOn(EventQueueTest.prototype, "processEvent")
        .mockImplementationOnce(async function (processContext, key, queueEntries) {
          await testHelper.insertEventEntry(cds.tx(processContext), {
            numberOfEntries: 1,
            type: "TransactionMode",
            subType: "alwaysRollback",
            randomGuid: true,
          });
          this.setShouldRollbackTransaction(key);
          return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
        });
      await eventQueue.processEventQueue(context, "TransactionMode", "alwaysCommit");
      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(dbCounts).toMatchSnapshot();
      const events = await testHelper.selectEventQueueAndReturn(tx, 1);
      expect(events).toMatchSnapshot();
    });
  });

  describe("transactionMode=alwaysRollback", () => {
    it("one with error + one without error --> tx rollback because mode alwaysRollback", async () => {
      await cds.tx({}, (tx2) =>
        testHelper.insertEventEntry(tx2, {
          numberOfEntries: 2,
          type: "TransactionMode",
          subType: "alwaysRollback",
        })
      );
      dbCounts = {};
      jest.spyOn(EventQueueTest.prototype, "processEvent").mockImplementationOnce(async (processContext) => {
        await testHelper.insertEventEntry(cds.tx(processContext), {
          numberOfEntries: 1,
          type: "TransactionMode",
          subType: "alwaysRollback",
          randomGuid: true,
        });
        throw new Error("error during processing");
      });
      await eventQueue.processEventQueue(context, "TransactionMode", "alwaysRollback");
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error[0][1]).toMatchInlineSnapshot(`[Error: error during processing]`);
      expect(dbCounts).toMatchSnapshot();
      const result = await testHelper.selectEventQueueAndReturn(tx, 2);
      expect(result).toMatchSnapshot();
    });

    it("one green --> tx rollback even all green", async () => {
      await cds.tx({}, (tx2) =>
        testHelper.insertEventEntry(tx2, {
          numberOfEntries: 1,
          type: "TransactionMode",
          subType: "alwaysRollback",
        })
      );
      dbCounts = {};
      jest
        .spyOn(EventQueueTest.prototype, "processEvent")
        .mockImplementationOnce(async (processContext, key, queueEntries) => {
          await testHelper.insertEventEntry(cds.tx(processContext), {
            numberOfEntries: 1,
            type: "TransactionMode",
            subType: "alwaysRollback",
            randomGuid: true,
          });
          return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
        });
      await eventQueue.processEventQueue(context, "TransactionMode", "alwaysRollback");
      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(dbCounts).toMatchSnapshot();
      const result = await testHelper.selectEventQueueAndReturn(tx, 1);
      expect(result).toMatchSnapshot();
    });
  });

  describe("hookForExceededEvents", () => {
    it("if event retries is exceeded hookForExceededEvents should be called and correct event status", async () => {
      const code = cds.utils.uuid();
      jest
        .spyOn(EventQueueTest.prototype, "hookForExceededEvents")
        .mockImplementationOnce(async function (exceededEvent) {
          expect(exceededEvent.payload.testPayload).toEqual(123);
          await this.tx.run(
            INSERT.into("sap.eventqueue.Lock").entries({
              code: code,
            })
          );
        });
      await cds.tx({}, async (tx2) => {
        const event = testHelper.getEventEntry();
        event.status = eventQueue.EventProcessingStatus.Error;
        event.lastAttemptTimestamp = new Date().toISOString();
        event.attempts = 3;
        await eventQueue.publishEvent(tx2, event);
      });
      const event = eventQueue.config.events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(loggerMock.callsLengths().warn).toEqual(1);
      await testHelper.selectEventQueueAndExpectExceeded(tx);
      await expectLockValue(tx, code);
      expect(jest.spyOn(EventQueueTest.prototype, "hookForExceededEvents")).toHaveBeenCalledTimes(1);
      expect(dbCounts).toMatchSnapshot();
    });

    it("hookForExceededEvents throws - rollback + counter increase", async () => {
      const code = cds.utils.uuid();
      jest.spyOn(EventQueueTest.prototype, "hookForExceededEvents").mockImplementationOnce(async function () {
        await this.tx.run(
          INSERT.into("sap.eventqueue.Lock").entries({
            code: code,
          })
        );
        throw new Error("sad chocolate");
      });
      await cds.tx({}, async (tx2) => {
        const event = testHelper.getEventEntry();
        event.status = eventQueue.EventProcessingStatus.Error;
        event.lastAttemptTimestamp = new Date().toISOString();
        event.attempts = 3;
        await eventQueue.publishEvent(tx2, event);
      });
      const event = eventQueue.config.events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.callsLengths().warn).toEqual(0);
      await testHelper.selectEventQueueAndExpectError(tx, 1, 4);
      await expectLockValue(tx, undefined);
      expect(jest.spyOn(EventQueueTest.prototype, "hookForExceededEvents")).toHaveBeenCalledTimes(1);
      expect(dbCounts).toMatchSnapshot();
    });

    it("hookForExceededEvents throws - rollback + second one succeeds", async () => {
      const code = cds.utils.uuid();
      jest
        .spyOn(EventQueueTest.prototype, "hookForExceededEvents")
        .mockImplementationOnce(async function () {
          await this.tx.run(
            INSERT.into("sap.eventqueue.Lock").entries({
              code: code,
            })
          );
          throw new Error("sad chocolate");
        })
        .mockImplementationOnce(async function () {
          await this.tx.run(
            INSERT.into("sap.eventqueue.Lock").entries({
              code: code,
            })
          );
        });
      await cds.tx({}, async (tx2) => {
        const event = testHelper.getEventEntry();
        event.status = eventQueue.EventProcessingStatus.Error;
        event.lastAttemptTimestamp = new Date().toISOString();
        event.attempts = 3;
        await eventQueue.publishEvent(tx2, event);
      });

      // First iteration with error
      const event = eventQueue.config.events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.callsLengths().warn).toEqual(0);
      await testHelper.selectEventQueueAndExpectError(tx, 1, 4);
      await expectLockValue(tx, undefined);
      expect(jest.spyOn(EventQueueTest.prototype, "hookForExceededEvents")).toHaveBeenCalledTimes(1);
      loggerMock.clearCalls();

      // Second iteration successful
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(loggerMock.callsLengths().warn).toEqual(1);
      await testHelper.selectEventQueueAndExpectExceeded(tx, 1, 5);
      await expectLockValue(tx, code);
      expect(jest.spyOn(EventQueueTest.prototype, "hookForExceededEvents")).toHaveBeenCalledTimes(2);
    });

    it("hookForExceededEvents has 3 tries after that should be set to exceeded without invoking hook again", async () => {
      const code = cds.utils.uuid();
      async function mockFunction() {
        await this.tx.run(
          INSERT.into("sap.eventqueue.Lock").entries({
            code: code,
          })
        );
        throw new Error("sad chocolate");
      }

      jest
        .spyOn(EventQueueTest.prototype, "hookForExceededEvents")
        .mockImplementationOnce(mockFunction)
        .mockImplementationOnce(mockFunction)
        .mockImplementationOnce(mockFunction);

      await cds.tx({}, async (tx2) => {
        const event = testHelper.getEventEntry();
        event.status = eventQueue.EventProcessingStatus.Error;
        event.lastAttemptTimestamp = new Date().toISOString();
        event.attempts = 3;
        await eventQueue.publishEvent(tx2, event);
      });

      const event = eventQueue.config.events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.callsLengths().warn).toEqual(0);
      await testHelper.selectEventQueueAndExpectError(tx, 1, 4);
      await expectLockValue(tx, undefined);
      loggerMock.clearCalls();

      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.callsLengths().warn).toEqual(0);
      await testHelper.selectEventQueueAndExpectError(tx, 1, 5);
      await expectLockValue(tx, undefined);
      loggerMock.clearCalls();

      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.callsLengths().warn).toEqual(0);
      await testHelper.selectEventQueueAndExpectError(tx, 1, 6);
      await expectLockValue(tx, undefined);
      loggerMock.clearCalls();

      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.callsLengths().warn).toEqual(0);
      await testHelper.selectEventQueueAndExpectExceeded(tx, 1, 7);
      await expectLockValue(tx, undefined);
      expect(jest.spyOn(EventQueueTest.prototype, "hookForExceededEvents")).toHaveBeenCalledTimes(3);
    });

    it("one which is exceeded and one for which the exceeded event has been exceeded", async () => {
      const code = cds.utils.uuid();
      async function mockFunction() {
        await this.tx.run(
          INSERT.into("sap.eventqueue.Lock").entries({
            code: code,
          })
        );
      }
      jest.spyOn(EventQueueTest.prototype, "hookForExceededEvents").mockImplementationOnce(mockFunction);

      await cds.tx({}, async (tx2) => {
        const event = testHelper.getEventEntry();
        const event1 = testHelper.getEventEntry();
        event.status = eventQueue.EventProcessingStatus.Error;
        event1.status = eventQueue.EventProcessingStatus.Error;
        event.lastAttemptTimestamp = new Date().toISOString();
        event1.lastAttemptTimestamp = new Date().toISOString();
        event.attempts = 3;
        event1.attempts = 6;
        await eventQueue.publishEvent(tx2, [event, event1]);
      });

      const event = eventQueue.config.events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(
        await tx.run(SELECT.from("sap.eventqueue.Event").orderBy("status").columns("status", "attempts"))
      ).toMatchSnapshot();
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.callsLengths().warn).toEqual(1);
      await expectLockValue(tx, code);
      expect(jest.spyOn(EventQueueTest.prototype, "hookForExceededEvents")).toHaveBeenCalledTimes(1);
    });
  });

  describe("periodic events", () => {
    beforeAll(async () => {
      eventQueue.config.initialized = false;
      const configFilePath = path.join(__dirname, "..", "./test", "asset", "config.yml");
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
        registerAsEventProcessor: false,
      });
    });

    it("insert and process - should call schedule next", async () => {
      const event = eventQueue.config.periodicEvents[0];
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEvents.checkAndInsertPeriodicEvents(tx2.context);
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();

      await processEventQueue(context, event.type, event.subType);

      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectDone(tx);
    });

    it("insert process - should handle if the event is already running - execute anyway", async () => {
      const event = eventQueue.config.periodicEvents[0];
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEvents.checkAndInsertPeriodicEvents(tx2.context);

        const currentEntry = await tx2.run(SELECT.one.from("sap.eventqueue.Event"));
        delete currentEntry.ID;
        currentEntry.status = 1;
        currentEntry.attempts = 1;
        await tx2.run(INSERT.into("sap.eventqueue.Event").entries(currentEntry));
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();

      await processEventQueue(context, event.type, event.subType);

      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      const events = await testHelper.selectEventQueueAndReturn(tx, 2);
      const [running, done] = events.sort((a, b) => a.status - b.status);
      expect(running).toEqual({
        status: EventProcessingStatus.InProgress,
        attempts: 1,
        startAfter: expect.any(String),
      });
      expect(done).toEqual({
        status: EventProcessingStatus.Done,
        attempts: 1,
        startAfter: expect.any(String),
      });
    });

    it("if delayed within the next two intervals should schedule next and execute direct", async () => {
      const event = eventQueue.config.periodicEvents[0];
      const newDate = new Date(Date.now() - 35 * 1000);
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEvents.checkAndInsertPeriodicEvents(tx2.context);
        await tx2.run(
          UPDATE.entity("sap.eventqueue.Event").set({
            startAfter: newDate,
          })
        );
      });
      const scheduleNextSpy = jest.spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent");

      await processEventQueue(context, event.type, event.subType);

      expect(scheduleNextSpy).toHaveBeenCalledTimes(2);
      expect(loggerMock.callsLengths().error).toEqual(0);
      const events = await testHelper.selectEventQueueAndReturn(tx, 3);
      const [done, done2, open] = events.sort((a, b) => new Date(a.startAfter) - new Date(b.startAfter));
      expect(done).toEqual({
        status: EventProcessingStatus.Done,
        attempts: 1,
        startAfter: newDate.toISOString(),
      });
      expect(done2).toEqual({
        status: EventProcessingStatus.Done,
        attempts: 1,
        startAfter: new Date(newDate.getTime() + 30 * 1000).toISOString(),
      });
      expect(open).toEqual({
        status: EventProcessingStatus.Open,
        attempts: 0,
        startAfter: new Date(newDate.getTime() + 60 * 1000).toISOString(),
      });
    });

    it("if delayed more than next two intervals should schedule next and execute direct - should adjust interval", async () => {
      const event = eventQueue.config.periodicEvents[0];
      const newDate = new Date(Date.now() - 65 * 1000);
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEvents.checkAndInsertPeriodicEvents(tx2.context);
        await tx2.run(
          UPDATE.entity("sap.eventqueue.Event").set({
            startAfter: newDate,
          })
        );
      });
      const scheduleNextSpy = jest.spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent");

      await processEventQueue(context, event.type, event.subType);

      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(
        loggerMock.calls().info.find(([log]) => log === "interval adjusted because shifted more than one interval")
      ).toBeTruthy();
      const events = await testHelper.selectEventQueueAndReturn(tx, 2);
      const [done, open] = events.sort((a, b) => new Date(a.startAfter) - new Date(b.startAfter));
      expect(done).toEqual({
        status: EventProcessingStatus.Done,
        attempts: 1,
        startAfter: newDate.toISOString(),
      });
      expect(open).toEqual({
        status: EventProcessingStatus.Open,
        attempts: 0,
        startAfter: expect.anything(),
      });
      expect(new Date(open.startAfter) <= new Date(Date.now() + 30 * 1000)).toBeTruthy();
    });

    it("insert and process - next event should be scheduled with correct params", async () => {
      const event = eventQueue.config.periodicEvents[0];
      const scheduler = eventScheduler.getInstance();
      const scheduleEventSpy = jest.spyOn(scheduler, "scheduleEvent").mockReturnValueOnce();
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEvents.checkAndInsertPeriodicEvents(tx2.context);
      });

      await processEventQueue(context, event.type, event.subType);

      expect(scheduleEventSpy).toHaveBeenCalledTimes(1);
      expect(scheduleEventSpy.mock.calls[0]).toEqual([undefined, "HealthCheck_PERIODIC", "DB", expect.anything()]);
      expect(loggerMock.callsLengths().error).toEqual(0);
      const events = await testHelper.selectEventQueueAndReturn(tx, 2);
      const [open, done] = events.sort((a, b) => a.status - b.status);
      expect(open).toEqual({
        status: EventProcessingStatus.Open,
        attempts: 0,
        startAfter: new Date(new Date(done.startAfter).getTime() + event.interval * 1000).toISOString(),
      });
      expect(done).toEqual({
        status: EventProcessingStatus.Done,
        attempts: 1,
        startAfter: new Date(done.startAfter).toISOString(),
      });
    });

    describe("transactions modes", () => {
      it("always rollback", async () => {
        const event = eventQueue.config.periodicEvents[0];
        await cds.tx({}, async (tx2) => {
          checkAndInsertPeriodicEventsMock.mockRestore();
          await periodicEvents.checkAndInsertPeriodicEvents(tx2.context);
        });
        const scheduleNextSpy = jest
          .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
          .mockResolvedValueOnce();

        dbCounts = {};
        await processEventQueue(context, event.type, event.subType);

        expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
        expect(loggerMock.callsLengths().error).toEqual(0);
        expect(dbCounts).toMatchSnapshot();

        await testHelper.selectEventQueueAndExpectDone(tx);
      });

      it("always commit", async () => {
        const event = eventQueue.config.periodicEvents[0];
        event.transactionMode = "alwaysCommit";
        await cds.tx({}, async (tx2) => {
          checkAndInsertPeriodicEventsMock.mockRestore();
          await periodicEvents.checkAndInsertPeriodicEvents(tx2.context);
        });
        const scheduleNextSpy = jest
          .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
          .mockResolvedValueOnce();

        dbCounts = {};
        await processEventQueue(context, event.type, event.subType);

        expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
        expect(loggerMock.callsLengths().error).toEqual(0);
        expect(dbCounts).toMatchSnapshot();

        await testHelper.selectEventQueueAndExpectDone(tx);
      });
    });
  });

  describe("end-to-end", () => {
    beforeAll(async () => {
      checkAndInsertPeriodicEventsMock = jest.spyOn(periodicEvents, "checkAndInsertPeriodicEvents").mockResolvedValue();
      eventQueue.config.initialized = false;
      const configFilePath = path.join(__dirname, "..", "./test", "asset", "config.yml");
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: true,
      });
    });

    it("insert entry, entry should be automatically processed", async () => {
      await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
      await waitEntryIsDone();
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectDone(tx);
    });

    it("insert one delayed entry and process - should be processed after timeout", async () => {
      await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2, { delayedSeconds: 5 }));
      const event = eventQueue.config.events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectOpen(tx);
      await waitEntryIsDone();
      await testHelper.selectEventQueueAndExpectDone(tx);
    });
  });
});

const waitEntryIsDone = async () => {
  let startTime = Date.now();
  while (true) {
    const row = await cds.tx({}, (tx2) => tx2.run(SELECT.one.from("sap.eventqueue.Event")));
    dbCounts["BEGIN"]--;
    dbCounts["COMMIT"]--;
    dbCounts["READ"]--;
    if (row?.status === EventProcessingStatus.Done) {
      break;
    }
    if (Date.now() - startTime > 120 * 1000) {
      throw new Error("entry not completed");
    }
    await promisify(setTimeout)(50);
  }
  return false;
};

const expectLockValue = async (tx, value) => {
  const lock = await tx.run(
    SELECT.one.from("sap.eventqueue.Lock").where({
      code: value,
    })
  );
  expect(lock?.code).toEqual(value);
};
