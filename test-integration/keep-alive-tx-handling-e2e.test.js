"use strict";

const path = require("path");
const { promisify } = require("util");

const cds = require("@sap/cds");
cds.test(__dirname + "/_env");
const cdsHelper = require("../src/shared/cdsHelper");
jest.spyOn(cdsHelper, "getAllTenantIds").mockResolvedValue(null);

const eventQueue = require("../src");
const runners = require("../src/runner/runner");
const dbHandler = require("../src/dbHandler");
jest.spyOn(runners, "singleTenantDb").mockResolvedValue();
const testHelper = require("../test/helper");
const EventQueueTest = require("../test/asset/EventQueueTest");
const { EventProcessingStatus } = require("../src");
const { Logger: mockLogger } = require("../test/mocks/logger");
const distributedLock = require("../src/shared/distributedLock");
const periodicEvents = require("../src/periodicEvents");
const { publishEvent } = require("../src/publishEvent");
const redisPub = require("../src/redis/redisPub");

const configFilePath = path.join(__dirname, "..", "./test", "asset", "config.yml");

let dbCounts = {};
describe("keep-alive-tx-handling-e2e", () => {
  let context;
  let tx;
  let loggerMock;

  beforeAll(async () => {
    jest.spyOn(periodicEvents, "checkAndInsertPeriodicEvents").mockResolvedValue();
    cds.env.eventQueue = {
      periodicEvents: {
        "EVENT_QUEUE_BASE/DELETE_EVENTS": {
          priority: "low",
          impl: "./housekeeping/EventQueueDeleteEvents",
          load: 20,
          interval: 86400,
          internalEvent: true,
        },
      },
    };
    await eventQueue.initialize({
      configFilePath,
      processEventsAfterPublish: false,
      registerAsEventProcessor: false,
      isEventQueueActive: false,
    });
    loggerMock = mockLogger();
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
    eventQueue.config.tenantIdFilterEventProcessing = null;
  });

  afterEach(async () => {
    await tx.rollback();
    jest.clearAllMocks();
    jest.spyOn(EventQueueTest.prototype, "processEvent").mockRestore();
  });

  afterAll(async () => {
    await cds.disconnect();
    await cds.shutdown();
  });

  describe("keep alive processing", () => {
    let isolatedNoParallel, alwaysCommit, isolatedNoParallelSingleSelect;
    beforeEach(() => {
      isolatedNoParallel = eventQueue.config._rawEventMap[["TransactionMode", "isolatedForKeepAlive"].join("##")];
      isolatedNoParallelSingleSelect =
        eventQueue.config._rawEventMap[["TransactionMode", "isolatedForKeepAliveSingleSelect"].join("##")];
      alwaysCommit = eventQueue.config._rawEventMap[["TransactionMode", "alwaysCommitForKeepAlive"].join("##")];
      isolatedNoParallel.parallelEventProcessing = 1;
      alwaysCommit.parallelEventProcessing = 1;
      for (let i = 0; i < cds.services.db._handlers.before.length; i++) {
        const handler = cds.services.db._handlers.before[i];
        if (handler.before === "READ") {
          cds.services.db._handlers.before.splice(i, 1);
        }
      }
    });

    describe("commitOnEventLevel", () => {
      it("straight forward", async () => {
        await cds.tx({}, (tx2) =>
          testHelper.insertEventEntry(tx2, {
            numberOfEntries: 2,
            type: isolatedNoParallel.type,
            subType: isolatedNoParallel.subType,
          })
        );
        const { db } = cds.services;
        const { Event } = cds.entities("sap.eventqueue");
        let forUpdateCounter = 0;
        db.before("READ", Event, (req) => {
          if (req.query.SELECT.forUpdate) {
            // 1 counter is select events; 2 keep alive request
            forUpdateCounter++;
          }
        });
        jest
          .spyOn(EventQueueTest.prototype, "processEvent")
          .mockImplementationOnce(async function (processContext, key, queueEntries) {
            await promisify(setTimeout)(2500);
            return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
          });
        await eventQueue.processEventQueue(context, isolatedNoParallel.type, isolatedNoParallel.subType);
        expect(forUpdateCounter).toBeGreaterThanOrEqual(2);
        expect(loggerMock.callsLengths().error).toEqual(0);
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
      });

      it("renew outer lock between two events", async () => {
        await cds.tx({}, (tx2) =>
          testHelper.insertEventEntry(tx2, {
            numberOfEntries: 2,
            type: isolatedNoParallelSingleSelect.type,
            subType: isolatedNoParallelSingleSelect.subType,
          })
        );
        const { db } = cds.services;
        const { Event } = cds.entities("sap.eventqueue");
        let forUpdateCounter = 0;
        db.before("READ", Event, (req) => {
          if (req.query.SELECT.forUpdate) {
            // 1 counter is select events; 2 keep alive request
            forUpdateCounter++;
          }
        });
        const renewLockSpy = jest.spyOn(distributedLock, "renewLock");
        jest
          .spyOn(EventQueueTest.prototype, "processEvent")
          .mockImplementationOnce(async function (processContext, key, queueEntries) {
            await promisify(setTimeout)(950);
            return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
          });
        await eventQueue.processEventQueue(
          context,
          isolatedNoParallelSingleSelect.type,
          isolatedNoParallelSingleSelect.subType
        );
        expect(forUpdateCounter).toBeGreaterThanOrEqual(1);
        expect(renewLockSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(loggerMock.callsLengths().error).toEqual(0);
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
      });

      it("first keep alive fails; second one should update", async () => {
        await cds.tx({}, (tx2) =>
          testHelper.insertEventEntry(tx2, {
            numberOfEntries: 2,
            type: isolatedNoParallel.type,
            subType: isolatedNoParallel.subType,
          })
        );

        const { db } = cds.services;
        const { Event } = cds.entities("sap.eventqueue");
        let forUpdateCounter = 0;
        db.before("READ", Event, (req) => {
          if (req.query.SELECT.forUpdate) {
            // 1 counter is select events; 2 keep alive request
            forUpdateCounter++;
            if (forUpdateCounter === 2) {
              throw Error("error in keep alive - db error");
            }
          }
        });

        const renewLockSpy = jest.spyOn(distributedLock, "renewLock");
        jest
          .spyOn(EventQueueTest.prototype, "processEvent")
          .mockImplementationOnce(async function (processContext, key, queueEntries) {
            await promisify(setTimeout)(2500);
            return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
          });
        await eventQueue.processEventQueue(context, isolatedNoParallel.type, isolatedNoParallel.subType);
        expect(loggerMock.callsLengths().error).toEqual(1);
        expect(loggerMock.calls().error[0][0]).toEqual("keep alive handling failed!");
        expect(renewLockSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
      });

      it("should not process modified events", async () => {
        await cds.tx({}, (tx2) =>
          testHelper.insertEventEntry(tx2, {
            numberOfEntries: 2,
            type: isolatedNoParallel.type,
            subType: isolatedNoParallel.subType,
          })
        );
        jest
          .spyOn(EventQueueTest.prototype, "processEvent")
          .mockImplementationOnce(async function (processContext, key, queueEntries) {
            await cds.tx({}, (tx) => tx.run(UPDATE("sap.eventqueue.Event").set({ lastAttemptTimestamp: new Date() })));
            await promisify(setTimeout)(2500);
            return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
          });
        await eventQueue.processEventQueue(context, isolatedNoParallel.type, isolatedNoParallel.subType);
        expect(loggerMock.callsLengths().error).toEqual(0);
        expect(loggerMock.callsLengths().warn).toEqual(1);
        expect(loggerMock.calls().warn[0][0]).toEqual(
          "Event data has been modified on the database. Further processing skipped. Parallel running events might have already commited status!"
        );
        const events = await testHelper.selectEventQueueAndReturn(tx, { expectedLength: 2 });
        expect(events).toEqual([expect.objectContaining({ status: 1 }), expect.objectContaining({ status: 2 })]);
      });

      it("parallel processing - both events are already started and return a valid status", async () => {
        isolatedNoParallel.parallelEventProcessing = 2;
        await cds.tx({}, (tx2) =>
          testHelper.insertEventEntry(tx2, {
            numberOfEntries: 2,
            type: isolatedNoParallel.type,
            subType: isolatedNoParallel.subType,
          })
        );
        const { db } = cds.services;
        const { Event } = cds.entities("sap.eventqueue");
        let forUpdateCounter = 0;
        db.before("READ", Event, (req) => {
          if (req.query.SELECT.forUpdate) {
            // 1 counter is select events; 2 keep alive request
            forUpdateCounter++;
          }
        });
        jest
          .spyOn(EventQueueTest.prototype, "processEvent")
          .mockImplementationOnce(async function (processContext, key, queueEntries) {
            await cds.tx({}, (tx) => tx.run(UPDATE("sap.eventqueue.Event").set({ lastAttemptTimestamp: new Date() })));
            await promisify(setTimeout)(2500);
            return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
          });
        await eventQueue.processEventQueue(context, isolatedNoParallel.type, isolatedNoParallel.subType);
        // NOTE: with parallel processing it should be 2 as both handlers run in parallel (processing is quicker)
        expect(forUpdateCounter).toBeGreaterThanOrEqual(2);
        expect(loggerMock.callsLengths().error).toEqual(0);
        expect(loggerMock.callsLengths().warn).toEqual(1);
        expect(loggerMock.calls().warn[0][0]).toEqual(
          "Event data has been modified on the database. Further processing skipped. Parallel running events might have already commited status!"
        );
        const events = await testHelper.selectEventQueueAndReturn(tx, { expectedLength: 2 });
        expect(events).toEqual([expect.objectContaining({ status: 2 }), expect.objectContaining({ status: 2 })]);
      });
    });

    describe("alwaysCommit", () => {
      it("straight forward", async () => {
        await cds.tx({}, (tx2) =>
          testHelper.insertEventEntry(tx2, {
            numberOfEntries: 2,
            type: alwaysCommit.type,
            subType: alwaysCommit.subType,
          })
        );
        const { db } = cds.services;
        const { Event } = cds.entities("sap.eventqueue");
        let forUpdateCounter = 0;
        db.before("READ", Event, (req) => {
          if (req.query.SELECT.forUpdate) {
            // 1 counter is select events; 2 keep alive request
            forUpdateCounter++;
          }
        });
        jest
          .spyOn(EventQueueTest.prototype, "processEvent")
          .mockImplementationOnce(async function (processContext, key, queueEntries) {
            await promisify(setTimeout)(2500);
            return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
          });
        await eventQueue.processEventQueue(context, alwaysCommit.type, alwaysCommit.subType);
        expect(forUpdateCounter).toBeGreaterThanOrEqual(2);
        expect(loggerMock.callsLengths().error).toEqual(0);
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
      });

      it("should not process modified events", async () => {
        await cds.tx({}, (tx2) =>
          testHelper.insertEventEntry(tx2, {
            numberOfEntries: 2,
            type: alwaysCommit.type,
            subType: alwaysCommit.subType,
          })
        );
        const { db } = cds.services;
        const { Event } = cds.entities("sap.eventqueue");
        let forUpdateCounter = 0;
        db.before("READ", Event, (req) => {
          if (req.query.SELECT.forUpdate) {
            // 1 counter is select events; 2 keep alive request
            forUpdateCounter++;
          }
        });
        jest
          .spyOn(EventQueueTest.prototype, "processEvent")
          .mockImplementationOnce(async function (processContext, key, queueEntries) {
            await cds.tx({}, (tx) => tx.run(UPDATE("sap.eventqueue.Event").set({ lastAttemptTimestamp: new Date() })));
            await promisify(setTimeout)(2500);
            return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
          });
        await eventQueue.processEventQueue(context, alwaysCommit.type, alwaysCommit.subType);
        expect(forUpdateCounter).toBeGreaterThanOrEqual(2);
        expect(loggerMock.callsLengths().error).toEqual(0);
        expect(loggerMock.callsLengths().warn).toEqual(1);
        expect(loggerMock.calls().warn[0][0]).toEqual(
          "Event data has been modified on the database. Further processing skipped. Parallel running events might have already commited status!"
        );
        const events = await testHelper.selectEventQueueAndReturn(tx, { expectedLength: 2 });
        expect(events).toEqual([expect.objectContaining({ status: 1 }), expect.objectContaining({ status: 2 })]);
      });

      it("parallel processing - both events are already started and return a valid status", async () => {
        alwaysCommit.parallelEventProcessing = 2;
        await cds.tx({}, (tx2) =>
          testHelper.insertEventEntry(tx2, {
            numberOfEntries: 2,
            type: alwaysCommit.type,
            subType: alwaysCommit.subType,
          })
        );
        const { db } = cds.services;
        const { Event } = cds.entities("sap.eventqueue");
        let forUpdateCounter = 0;
        db.before("READ", Event, (req) => {
          if (req.query.SELECT.forUpdate) {
            // 1 counter is select events; 2 keep alive request
            forUpdateCounter++;
          }
        });
        jest
          .spyOn(EventQueueTest.prototype, "processEvent")
          .mockImplementationOnce(async function (processContext, key, queueEntries) {
            await cds.tx({}, (tx) => tx.run(UPDATE("sap.eventqueue.Event").set({ lastAttemptTimestamp: new Date() })));
            await promisify(setTimeout)(2500);
            return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
          });
        await eventQueue.processEventQueue(context, alwaysCommit.type, alwaysCommit.subType);
        expect(forUpdateCounter).toBeGreaterThanOrEqual(2);
        expect(loggerMock.callsLengths().error).toEqual(0);
        expect(loggerMock.callsLengths().warn).toEqual(1);
        expect(loggerMock.calls().warn[0][0]).toEqual(
          "Event data has been modified on the database. Further processing skipped. Parallel running events might have already commited status!"
        );
        const events = await testHelper.selectEventQueueAndReturn(tx, { expectedLength: 2 });
        expect(events).toEqual([expect.objectContaining({ status: 2 }), expect.objectContaining({ status: 2 })]);
      });
    });
  });

  describe("error handling on commit errors - isolated transaction mode", () => {
    const type = "TransactionMode";
    const subType = "isolated";
    afterEach(async () => {
      const db = await cds.connect.to("db");
      db.handlers.after = [];
    });

    it("one red", async () => {
      await cds.tx({}, (tx2) =>
        testHelper.insertEventEntry(tx2, {
          type,
          subType,
        })
      );
      dbCounts = {};
      jest
        .spyOn(EventQueueTest.prototype, "processEvent")
        .mockImplementationOnce(async (processContext, key, queueEntries) => {
          const db = await cds.connect.to("db");

          const { "sap.eventqueue.Lock": Lock } = cds.entities;
          db.after("READ", Lock, async (data, context) => {
            context.on("succeeded", async () => {
              throw new Error("oh boy");
            });
          });
          await cds.tx(processContext).run(SELECT.one.from(Lock));
          return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
        });
      await eventQueue.processEventQueue(context, type, subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error[0][0]).toEqual(
        "business transaction commited but succeeded|done|failed threw a error!"
      );
      await testHelper.selectEventQueueAndExpectDone(tx);
      expect(dbCounts).toMatchSnapshot();
    });

    it("two red", async () => {
      await cds.tx({}, (tx2) =>
        testHelper.insertEventEntry(tx2, {
          type,
          subType,
          numberOfEntries: 2,
        })
      );
      dbCounts = {};
      jest
        .spyOn(EventQueueTest.prototype, "processEvent")
        .mockImplementation(async (processContext, key, queueEntries) => {
          const db = await cds.connect.to("db");

          const { "sap.eventqueue.Lock": Lock } = cds.entities;
          db.after("READ", Lock, async (data, context) => {
            context.on("succeeded", async () => {
              throw new Error("oh boy");
            });
          });
          await cds.tx(processContext).run(SELECT.one.from(Lock));
          return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
        });
      await eventQueue.processEventQueue(context, type, subType);
      expect(loggerMock.callsLengths().error).toEqual(2);
      expect(loggerMock.calls().error[0][0]).toEqual(
        "business transaction commited but succeeded|done|failed threw a error!"
      );
      await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
      expect(dbCounts).toMatchSnapshot();
    });

    it("one red and one green", async () => {
      await cds.tx({}, (tx2) =>
        testHelper.insertEventEntry(tx2, {
          type,
          subType,
          numberOfEntries: 2,
        })
      );
      dbCounts = {};
      let shouldThrow = true;
      jest
        .spyOn(EventQueueTest.prototype, "processEvent")
        .mockImplementation(async (processContext, key, queueEntries) => {
          const db = await cds.connect.to("db");
          const { "sap.eventqueue.Lock": Lock } = cds.entities;
          db.after("READ", Lock, async (data, context) => {
            context.on("succeeded", async () => {
              if (shouldThrow) {
                shouldThrow = false;
                throw new Error("oh boy");
              }
            });
          });
          await cds.tx(processContext).run(SELECT.one.from(Lock));
          return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
        });
      await eventQueue.processEventQueue(context, type, subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error[0][0]).toEqual(
        "business transaction commited but succeeded|done|failed threw a error!"
      );
      await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
      expect(dbCounts).toMatchSnapshot();
    });

    it("error on commit", async () => {
      await cds.tx({}, (tx2) =>
        testHelper.insertEventEntry(tx2, {
          type,
          subType,
        })
      );
      dbCounts = {};
      jest
        .spyOn(EventQueueTest.prototype, "processEvent")
        .mockImplementationOnce(async (processContext, key, queueEntries) => {
          const db = await cds.connect.to("db");

          const { "sap.eventqueue.Lock": Lock } = cds.entities;
          db.before("COMMIT", async () => {
            db.handlers.before.pop();
            throw new Error("oh boy");
          });
          await cds.tx(processContext).run(SELECT.one.from(Lock));
          return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
        });
      await eventQueue.processEventQueue(context, type, subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error[0][0]).toEqual(
        "Error in commit|rollback transaction, check handlers and constraints!"
      );
      await testHelper.selectEventQueueAndExpectError(tx);
      expect(dbCounts).toMatchSnapshot();
    });
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
      const events = await testHelper.selectEventQueueAndReturn(tx, { expectedLength: 3 });
      expect(events.sort((a, b) => a.status - b.status)).toMatchSnapshot();
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
      await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
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
      const events = await testHelper.selectEventQueueAndReturn(tx, { expectedLength: 3 });
      events.forEach((event) => delete event.startAfter);
      expect(events.sort((a, b) => a.status - b.status)).toMatchSnapshot();
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
      const events = await testHelper.selectEventQueueAndReturn(tx, { expectedLength: 1 });
      events.forEach((event) => delete event.startAfter);
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
      const result = await testHelper.selectEventQueueAndReturn(tx, { expectedLength: 2 });
      result.forEach((event) => delete event.startAfter);
      expect(result.sort((a, b) => a.status - b.status)).toMatchSnapshot();
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
      const result = await testHelper.selectEventQueueAndReturn(tx, { expectedLength: 1 });
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
      await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1, attempts: 4 });
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
      await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1, attempts: 4 });
      await expectLockValue(tx, undefined);
      expect(jest.spyOn(EventQueueTest.prototype, "hookForExceededEvents")).toHaveBeenCalledTimes(1);
      loggerMock.clearCalls();

      // Second iteration successful
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(loggerMock.callsLengths().warn).toEqual(1);
      await testHelper.selectEventQueueAndExpectExceeded(tx, { expectedLength: 1, attempts: 5 });
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
      await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1, attempts: 4 });
      await expectLockValue(tx, undefined);
      loggerMock.clearCalls();

      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.callsLengths().warn).toEqual(0);
      await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1, attempts: 5 });
      await expectLockValue(tx, undefined);
      loggerMock.clearCalls();

      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.callsLengths().warn).toEqual(0);
      await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1, attempts: 6 });
      await expectLockValue(tx, undefined);
      loggerMock.clearCalls();

      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.callsLengths().warn).toEqual(0);
      await testHelper.selectEventQueueAndExpectExceeded(tx, { expectedLength: 1, attempts: 7 });
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

  describe("parallel event processing in the same instance", () => {
    afterAll(() => {
      jest.spyOn(EventQueueTest.prototype, "processEvent").mockRestore();
    });

    const type = "SingleTenant";
    const subType = "MultiInstanceProcessing";
    it("insert two entries and select with chunk size one --> should process in parallel", async () => {
      await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2, { numberOfEntries: 2, type, subType }));
      dbCounts = {};
      const ids = Array(2)
        .fill(1)
        .map(() => cds.utils.uuid());
      const spy = jest
        .spyOn(EventQueueTest.prototype, "processEvent")
        .mockImplementation(async (processContext, key, queueEntries) => {
          await cds.tx(processContext).run(SELECT.from("sap.eventqueue.Lock"));
          return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
        });
      await Promise.all(
        ids.map((id) => cds.tx({ id }, (tx) => eventQueue.processEventQueue(tx.context, type, subType)))
      );

      // this tests that every event processor processed events
      expect(spy.mock.calls.map(([t]) => t.id).sort()).toEqual(ids.sort());
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
      expect(dbCounts).toMatchSnapshot();
    });

    it("insert 4 entries and select with chunk size one --> should process in parallel - twice", async () => {
      await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2, { numberOfEntries: 4, type, subType }));
      dbCounts = {};
      const ids = Array(2)
        .fill(1)
        .map(() => cds.utils.uuid());
      const spy = jest
        .spyOn(EventQueueTest.prototype, "processEvent")
        .mockImplementation(async (processContext, key, queueEntries) => {
          await cds.tx(processContext).run(SELECT.from("sap.eventqueue.Lock"));
          return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
        });

      await Promise.all(
        ids.map((id) => cds.tx({ id }, (tx) => eventQueue.processEventQueue(tx.context, type, subType)))
      );

      // this tests that every event processor processed events
      expect(spy.mock.calls.map(([t]) => t.id).sort()).toEqual([...ids, ...ids].sort());
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 4 });
      expect(dbCounts).toMatchSnapshot();
    });
  });

  describe("end-to-end", () => {
    let dbHandlerSpy;
    beforeAll(async () => {
      jest.spyOn(periodicEvents, "checkAndInsertPeriodicEvents").mockResolvedValue();
      cds._events.connect.splice(1, cds._events.connect.length - 1);
      eventQueue.config.initialized = false;
      dbHandlerSpy = jest.spyOn(dbHandler, "registerEventQueueDbHandler");
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: true,
        isEventQueueActive: true,
      });
      cds.emit("connect", await cds.connect.to("db"));
    });

    it("insert entry, entry should be automatically processed", async () => {
      expect(dbHandlerSpy).toHaveBeenCalledTimes(1);
      await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
      await waitEntryIsDone();
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectDone(tx);
    });

    it("insert entry, entry should be automatically processed also for two different entries", async () => {
      const broadcastSpy = jest.spyOn(redisPub, "broadcastEvent");
      await cds.tx({}, async (tx2) => {
        const test = testHelper.getEventEntry();
        const test1 = testHelper.getEventEntry();
        test1.type = "TransactionMode";
        test1.subType = "isolated";
        await testHelper.insertEventEntry(tx2, { entries: [test, test1] });
      });
      await waitEntriesIsDone();
      expect(broadcastSpy).toHaveBeenCalledWith(undefined, [
        {
          subType: "Task",
          type: "Notifications",
        },
        {
          subType: "isolated",
          type: "TransactionMode",
        },
      ]);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
    });

    it("if tenant id filter filters the tenant - should not process event", async () => {
      eventQueue.config.tenantIdFilterEventProcessing = () => false;
      const broadcastSpy = jest.spyOn(redisPub, "broadcastEvent");
      await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
      await promisify(setTimeout)(2000);
      expect(broadcastSpy).toHaveBeenCalledWith(undefined, [
        {
          subType: "Task",
          type: "Notifications",
        },
      ]);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectOpen(tx);
    });
  });

  describe("insertEventsBeforeCommit", () => {
    beforeAll(async () => {
      eventQueue.config.initialized = false;
      await eventQueue.initialize({
        configFilePath,
        insertEventsBeforeCommit: true,
        processEventsAfterPublish: false,
      });
      cds.emit("connect", await cds.connect.to("db"));
    });

    it("insert should happen with commit", async () => {
      const event = testHelper.getEventEntry();
      let tx = cds.tx({});
      await publishEvent(tx, event);
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 0 });
      await tx.commit();

      tx = cds.tx({});
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
      expect(loggerMock.callsLengths().error).toEqual(0);
      await tx.rollback();
    });

    it("insert should happen immediately if specified with skipInsertEventsBeforeCommit", async () => {
      const event = testHelper.getEventEntry();
      let tx = cds.tx({});
      await publishEvent(tx, event, { skipInsertEventsBeforeCommit: true });
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
      await tx.commit();

      tx = cds.tx({});
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
      expect(loggerMock.callsLengths().error).toEqual(0);
      await tx.rollback();
    });

    it("insert should not happen if tx is rolled back", async () => {
      const event = testHelper.getEventEntry();
      let tx = cds.tx({});
      await publishEvent(tx, event);
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 0 });
      await tx.rollback();

      tx = cds.tx({});
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 0 });
      expect(loggerMock.callsLengths().error).toEqual(0);
      await tx.rollback();
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
    if (Date.now() - startTime > 180 * 1000) {
      throw new Error("entry not completed");
    }
    await promisify(setTimeout)(50);
  }
  return false;
};

const waitEntriesIsDone = async () => {
  let startTime = Date.now();
  while (true) {
    const rows = await cds.tx({}, (tx2) => tx2.run(SELECT.from("sap.eventqueue.Event")));
    dbCounts["BEGIN"]--;
    dbCounts["COMMIT"]--;
    dbCounts["READ"]--;

    const oneRunning = rows.some((row) => row.status !== EventProcessingStatus.Done);
    if (!oneRunning) {
      break;
    }
    if (Date.now() - startTime > 180 * 1000) {
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
