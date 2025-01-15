"use strict";

const path = require("path");

const cds = require("@sap/cds/lib");

const eventQueue = require("../src");
const eventScheduler = require("../src/shared/eventScheduler");
const { checkAndInsertPeriodicEvents } = require("../src/periodicEvents");
const testHelper = require("./helper");
const EventQueueTest = require("./asset/EventQueueTest");
const EventQueueHealthCheck = require("./asset/EventQueueHealthCheckDb");
const { Logger: mockLogger } = require("./mocks/logger");
const { EventProcessingStatus } = require("../src/constants");
const { getOpenQueueEntries } = require("../src/runner/openEvents");
const { getEnvInstance } = require("../src/shared/env");
const config = require("../src/config");

const project = __dirname + "/asset/outboxProject"; // The project's root folder
cds.test(project);

describe("baseFunctionality", () => {
  let context, loggerMock;

  beforeAll(async () => {
    const configFilePath = path.join(__dirname, "asset", "config.yml");
    await eventQueue.initialize({
      configFilePath,
      processEventsAfterPublish: false,
      registerAsEventProcessor: false,
      useAsCAPOutbox: true,
    });
    loggerMock = mockLogger();
    jest.spyOn(cds, "log").mockImplementation((layer) => {
      return mockLogger(layer);
    });
  });

  beforeEach(async () => {
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    await cds.tx({}, async (tx) => {
      await tx.run(DELETE.from("sap.eventqueue.Lock"));
      await tx.run(DELETE.from("sap.eventqueue.Event"));
    });
    config.removeEvent("CAP_OUTBOX", "NotificationService");
    eventQueue.config.clearPeriodicEventBlockList();
    eventQueue.config.isEventBlockedCb = null;
  });

  afterEach(async () => {
    jest.clearAllMocks();
  });

  afterAll(() => cds.shutdown);

  describe("ad-hoc events", () => {
    test("empty queue - nothing to do", async () => {
      const event = eventQueue.config.events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    test("insert one entry and process", async () => {
      await cds.tx({}, (tx) => testHelper.insertEventEntry(tx));
      const event = eventQueue.config.events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectDone(tx));
    });

    test("should not process events that are suspended", async () => {
      await cds.tx({}, (tx) => testHelper.insertEventEntry(tx, { status: EventProcessingStatus.Suspended }));
      const event = eventQueue.config.events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(0);
      const eventFresh = await cds.tx({}, (tx) => testHelper.selectEventQueueAndReturn(tx, { expectedLength: 1 }));
      expect(eventFresh[0].status).toEqual(EventProcessingStatus.Suspended);
      expect(eventFresh[0].attempts).toEqual(0);
    });

    test("insert one delayed entry - should not directly be processed", async () => {
      await cds.tx({}, (tx) => testHelper.insertEventEntry(tx, { delayedSeconds: 15 }));
      const event = eventQueue.config.events[0];
      const eventSchedulerInstance = eventScheduler.getInstance();
      const eventSchedulerSpy = jest.spyOn(eventSchedulerInstance, "scheduleEvent").mockReturnValue();
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectOpen(tx));
      expect(eventSchedulerSpy).toHaveBeenCalledTimes(1);
    });

    test("insert one delayed entry after runInterval", async () => {
      await cds.tx({}, (tx) => testHelper.insertEventEntry(tx, { delayedSeconds: 500 }));
      const event = eventQueue.config.events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectOpen(tx));
    });

    test("insert one delayed entry in past - should be directly be processed", async () => {
      await cds.tx({}, (tx) => testHelper.insertEventEntry(tx, { delayedSeconds: -100 }));
      const event = eventQueue.config.events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectDone(tx));
    });

    test("should do nothing if no lock is available", async () => {
      await cds.tx({}, (tx) => testHelper.insertEventEntry(tx));
      jest.spyOn(eventQueue.EventQueueProcessorBase.prototype, "acquireDistributedLock").mockResolvedValueOnce(false);
      const event = eventQueue.config.events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectOpen(tx));
    });

    describe("error handling", () => {
      test("missing event implementation", async () => {
        await cds.tx({}, (tx) => testHelper.insertEventEntry(tx));
        await eventQueue.processEventQueue(context, "404", "NOT FOUND");
        expect(loggerMock.callsLengths().error).toEqual(1);
        expect(loggerMock.calls().error).toMatchSnapshot();
        await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectOpen(tx));
      });

      test("handle acquireDistributedLock fails", async () => {
        await cds.tx({}, (tx) => testHelper.insertEventEntry(tx));
        jest
          .spyOn(eventQueue.EventQueueProcessorBase.prototype, "acquireDistributedLock")
          .mockRejectedValueOnce(new Error("lock require failed"));
        const event = eventQueue.config.events[0];
        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(1);
        expect(loggerMock.calls().error).toMatchSnapshot();
        await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectOpen(tx));
      });

      test("handle getQueueEntriesAndSetToInProgress fails", async () => {
        await cds.tx({}, (tx) => testHelper.insertEventEntry(tx));
        jest
          .spyOn(eventQueue.EventQueueProcessorBase.prototype, "getQueueEntriesAndSetToInProgress")
          .mockRejectedValueOnce(new Error("db error"));
        const event = eventQueue.config.events[0];
        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(1);
        expect(loggerMock.calls().error).toMatchSnapshot();
        await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectOpen(tx));
      });

      test("handle modifyQueueEntry fails", async () => {
        await cds.tx({}, (tx) => testHelper.insertEventEntry(tx));
        jest.spyOn(eventQueue.EventQueueProcessorBase.prototype, "modifyQueueEntry").mockImplementationOnce(() => {
          throw new Error("syntax error");
        });
        const event = eventQueue.config.events[0];
        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(1);
        expect(loggerMock.calls().error).toMatchSnapshot();
        await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectError(tx));
      });

      test("handle checkEventAndGeneratePayload fails", async () => {
        await cds.tx({}, (tx) => testHelper.insertEventEntry(tx));
        jest
          .spyOn(EventQueueTest.prototype, "checkEventAndGeneratePayload")
          .mockRejectedValueOnce(new Error("syntax error"));
        const event = eventQueue.config.events[0];
        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(1);
        expect(loggerMock.calls().error).toMatchSnapshot();
        await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectError(tx));
      });

      test("handle clusterQueueEntries fails", async () => {
        await cds.tx({}, (tx) => testHelper.insertEventEntry(tx));
        jest.spyOn(eventQueue.EventQueueProcessorBase.prototype, "clusterQueueEntries").mockImplementationOnce(() => {
          throw new Error("syntax error");
        });
        const event = eventQueue.config.events[0];
        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(1);
        expect(loggerMock.calls().error).toMatchSnapshot();
        await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectError(tx));
      });

      test("undefined payload should be processed", async () => {
        const eventQueueEntry = testHelper.getEventEntry();
        eventQueueEntry.payload = undefined;
        jest
          .spyOn(EventQueueTest.prototype, "checkEventAndGeneratePayload")
          .mockImplementationOnce(async (queueEntry) => {
            return queueEntry.payload;
          });
        await cds.tx({}, async (tx) => {
          await tx.run(INSERT.into("sap.eventqueue.Event").entries(eventQueueEntry));
        });
        const event = eventQueue.config.events[0];
        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(0);
        await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectDone(tx));
      });

      test("null as payload should be set to done", async () => {
        const eventQueueEntry = testHelper.getEventEntry();
        eventQueueEntry.payload = undefined;
        jest.spyOn(EventQueueTest.prototype, "checkEventAndGeneratePayload").mockImplementationOnce(async () => {
          return null;
        });
        await cds.tx({}, async (tx) => {
          await tx.run(INSERT.into("sap.eventqueue.Event").entries(eventQueueEntry));
        });
        const event = eventQueue.config.events[0];
        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(0);
        await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectDone(tx));
      });

      test("undefined as payload should be treated as error", async () => {
        const eventQueueEntry = testHelper.getEventEntry();
        eventQueueEntry.payload = undefined;
        jest.spyOn(EventQueueTest.prototype, "checkEventAndGeneratePayload").mockImplementationOnce(async () => {
          return undefined;
        });
        await cds.tx({}, async (tx) => {
          await tx.run(INSERT.into("sap.eventqueue.Event").entries(eventQueueEntry));
        });
        const event = eventQueue.config.events[0];
        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(1);
        await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectError(tx));
      });

      test("handle undefined return for processEvent", async () => {
        jest.spyOn(EventQueueTest.prototype, "processEvent").mockImplementationOnce(async () => {
          return undefined;
        });
        await cds.tx({}, (tx) => testHelper.insertEventEntry(tx));
        const event = eventQueue.config.events[0];
        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(1);
        expect(loggerMock.calls().error).toMatchSnapshot();
        await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectError(tx));
      });
    });

    describe("insert events", () => {
      test("straight forward", async () => {
        const event = eventQueue.config.events[0];
        const events = await cds.tx({}, async (tx) => {
          await eventQueue.publishEvent(tx, {
            type: event.type,
            subType: event.subType,
            payload: JSON.stringify({
              testPayload: 123,
            }),
            startAfter: new Date(1699344489697),
          });
          return await tx.run(SELECT.from("sap.eventqueue.Event"));
        });
        expect(events).toHaveLength(1);
        events[0].startAfter = new Date(events[0].startAfter);
        expect(events[0]).toMatchObject({
          type: event.type,
          subType: event.subType,
          payload: JSON.stringify({
            testPayload: 123,
          }),
          startAfter: new Date(1699344489697),
        });
      });

      test("unknown event", async () => {
        await cds.tx({}, async (tx) => {
          await expect(
            eventQueue.publishEvent(tx, {
              type: "404",
              subType: "NOT FOUND",
              payload: JSON.stringify({
                testPayload: 123,
              }),
            })
          ).rejects.toThrowErrorMatchingInlineSnapshot(
            `"The event type and subType configuration is not configured! Maintain the combination in the config file."`
          );
          const events = await tx.run(SELECT.from("sap.eventqueue.Event"));
          expect(events).toHaveLength(0);
        });
      });

      test("not a proper date", async () => {
        const event = eventQueue.config.events[0];
        await cds.tx({}, async (tx) => {
          await expect(
            eventQueue.publishEvent(tx, {
              type: event.type,
              subType: event.subType,
              payload: JSON.stringify({
                testPayload: 123,
              }),
              startAfter: "notADate",
            })
          ).rejects.toThrowErrorMatchingInlineSnapshot(`"One or more events contain a date in a malformed format."`);
          const events = await tx.run(SELECT.from("sap.eventqueue.Event"));
          expect(events).toHaveLength(0);
        });
      });
    });
  });

  describe("periodic events", () => {
    test("straight forward", async () => {
      const event = eventQueue.config.periodicEvents[0];
      await cds.tx({}, async (tx) => {
        await checkAndInsertPeriodicEvents(tx.context);
      });
      let eventType;
      jest.spyOn(EventQueueHealthCheck.prototype, "processPeriodicEvent").mockImplementationOnce(async function () {
        eventType = this.eventType;
      });
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(eventType).toEqual("HealthCheck");
      expect(loggerMock.callsLengths().error).toEqual(0);
      const events = await cds.tx({}, (tx) =>
        testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 2,
          type: "HealthCheck_PERIODIC",
        })
      );
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

    test("should release lock if no entries is present", async () => {
      const event = eventQueue.config.periodicEvents[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await cds.tx({}, async (tx) => {
        await testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 0,
        });
        const locks = await tx.run(SELECT.from("sap.eventqueue.Lock"));
        expect(locks).toHaveLength(0);
      });
    });

    describe("block and unblock periodic tenants", () => {
      test("blocked event should not be executed", async () => {
        const event = eventQueue.config.periodicEvents[0];
        eventQueue.config.blockEvent("HealthCheck", "DB", true);
        await cds.tx({}, (tx) => checkAndInsertPeriodicEvents(tx.context));
        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(0);
        await cds.tx({}, (tx) =>
          testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1, type: "HealthCheck_PERIODIC" })
        );
      });

      test("blocked event for different tenant - should execute", async () => {
        const event = eventQueue.config.periodicEvents[0];
        eventQueue.config.blockEvent("HealthCheck", "DB", true, "345");
        await cds.tx({}, (tx) => checkAndInsertPeriodicEvents(tx.context));
        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(0);
        const events = await cds.tx({}, (tx) =>
          testHelper.selectEventQueueAndReturn(tx, {
            expectedLength: 2,
            type: "HealthCheck_PERIODIC",
          })
        );
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

      test("blocked event should not be executed - tenant specific", async () => {
        const event = eventQueue.config.periodicEvents[0];
        eventQueue.config.blockEvent("HealthCheck", "DB", true, "123");
        await cds.tx({}, (tx) => checkAndInsertPeriodicEvents(tx.context));
        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(0);
        await cds.tx({}, (tx) =>
          testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1, type: "HealthCheck_PERIODIC" })
        );
      });

      test("blocked event should not be executed - tenant specific - unblock and execute again", async () => {
        const event = eventQueue.config.periodicEvents[0];
        eventQueue.config.blockEvent("HealthCheck", "DB", true, "123");
        await cds.tx({}, (tx) => checkAndInsertPeriodicEvents(tx.context));
        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(0);
        await cds.tx({}, (tx) =>
          testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1, type: "HealthCheck_PERIODIC" })
        );

        eventQueue.config.unblockEvent("HealthCheck", "DB", true, "123");

        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(0);
        const events = await cds.tx({}, (tx) =>
          testHelper.selectEventQueueAndReturn(tx, {
            expectedLength: 2,
            type: "HealthCheck_PERIODIC",
          })
        );
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

      test("blocked event should not be executed - all tenant - unblock tenant", async () => {
        const event = eventQueue.config.periodicEvents[0];
        eventQueue.config.blockEvent("HealthCheck", "DB", true);
        await cds.tx({}, (tx) => checkAndInsertPeriodicEvents(tx.context));
        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(0);
        await cds.tx({}, (tx) =>
          testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1, type: "HealthCheck_PERIODIC" })
        );

        eventQueue.config.unblockEvent("HealthCheck", "DB", true, "123");

        await eventQueue.processEventQueue(context, event.type, event.subType);
        expect(loggerMock.callsLengths().error).toEqual(0);
        const events = await cds.tx({}, (tx) =>
          testHelper.selectEventQueueAndReturn(tx, {
            expectedLength: 2,
            type: "HealthCheck_PERIODIC",
          })
        );
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

      describe("cb api", () => {
        test("blocked event should not be executed", async () => {
          const event = eventQueue.config.periodicEvents[0];
          eventQueue.config.isEventBlockedCb = () => true;
          await cds.tx({}, (tx) => checkAndInsertPeriodicEvents(tx.context));
          await eventQueue.processEventQueue(context, event.type, event.subType);
          expect(loggerMock.callsLengths().error).toEqual(0);
          await cds.tx({}, (tx) =>
            testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1, type: "HealthCheck_PERIODIC" })
          );
        });

        test("blocked ad-hoc event should not be executed", async () => {
          const event = eventQueue.config.events[0];
          eventQueue.config.isEventBlockedCb = () => true;
          await cds.tx({}, (tx) => testHelper.insertEventEntry(tx));
          await eventQueue.processEventQueue(context, event.type, event.subType);
          expect(loggerMock.callsLengths().error).toEqual(0);
          await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 }));
        });

        test("not blocked event - should execute", async () => {
          const event = eventQueue.config.periodicEvents[0];
          eventQueue.config.isEventBlockedCb = () => false;
          await cds.tx({}, (tx) => checkAndInsertPeriodicEvents(tx.context));
          await eventQueue.processEventQueue(context, event.type, event.subType);
          expect(loggerMock.callsLengths().error).toEqual(0);
          const events = await cds.tx({}, (tx) =>
            testHelper.selectEventQueueAndReturn(tx, {
              expectedLength: 2,
              type: "HealthCheck_PERIODIC",
            })
          );
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
      });
    });

    test("two open events - not allowed", async () => {
      const event = eventQueue.config.periodicEvents[0];
      await cds.tx({}, (tx) => checkAndInsertPeriodicEvents(tx.context));
      await cds.tx({}, (tx) =>
        tx.run(
          INSERT.into("sap.eventqueue.Event").entries({
            type: event.type,
            subType: event.subType,
            startAfter: new Date(),
          })
        )
      );

      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      const log = loggerMock.calls().error[0];
      delete log[1].queueEntriesIds;
      expect(log).toMatchSnapshot();
      const events = await cds.tx({}, (tx) =>
        testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 3,
          type: "HealthCheck_PERIODIC",
        })
      );
      const [open, done1, done2] = events.sort((a, b) => a.status - b.status);
      expect(open).toEqual({
        status: EventProcessingStatus.Open,
        attempts: 0,
        startAfter: expect.any(String),
      });
      expect(done1).toEqual({
        status: EventProcessingStatus.Done,
        attempts: 1,
        startAfter: new Date(done1.startAfter).toISOString(),
      });
      expect(done2).toEqual({
        status: EventProcessingStatus.Done,
        attempts: 1,
        startAfter: new Date(done2.startAfter).toISOString(),
      });
    });
  });

  describe("getOpenQueueEntries", () => {
    describe("filterAppSpecificEvents", () => {
      beforeEach(async () => {
        const service = await cds.connect.to("NotificationService");
        for (const sym of Object.getOwnPropertySymbols(service)) {
          delete service[sym];
        }
      });

      test("return open event types", async () => {
        const result = await cds.tx({}, async (tx) => {
          await testHelper.insertEventEntry(tx);
          await checkAndInsertPeriodicEvents(tx.context);
          return await getOpenQueueEntries(tx, false);
        });
        expect(result.length).toMatchInlineSnapshot(`8`); // 1 ad-hoc and 4 periodic
        expect(result).toMatchSnapshot();
      });

      test("should also return not existing events", async () => {
        const result = await cds.tx({}, async (tx) => {
          await testHelper.insertEventEntry(tx);
          await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ type: "123" }));
          return await getOpenQueueEntries(tx, false);
        });
        expect(result.length).toMatchInlineSnapshot(`1`);
      });

      test("should not return not existing events if cratedAt older than 30 days", async () => {
        await cds.tx({}, async (tx) => {
          await testHelper.insertEventEntry(tx);
          await tx.run(
            UPDATE.entity("sap.eventqueue.Event").set({
              type: "123",
              createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
            })
          );
          const result = await getOpenQueueEntries(tx, false);
          expect(result.length).toMatchInlineSnapshot(`0`);
        });
      });

      test("should return existing events if startAfter within 30 days but createdAt older than 30 days", async () => {
        await cds.tx({}, async (tx) => {
          await testHelper.insertEventEntry(tx);
          await tx.run(
            UPDATE.entity("sap.eventqueue.Event").set({
              type: "123",
              createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
              startAfter: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString(),
            })
          );
          const result = await getOpenQueueEntries(tx, false);
          expect(result.length).toMatchInlineSnapshot(`1`);
        });
      });

      test("should return not existing events if startAfter and createdAt is after 30 days", async () => {
        await cds.tx({}, async (tx) => {
          await testHelper.insertEventEntry(tx);
          await tx.run(
            UPDATE.entity("sap.eventqueue.Event").set({
              type: "123",
              createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
              startAfter: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString(),
            })
          );
          const result = await getOpenQueueEntries(tx, false);
          expect(result.length).toMatchInlineSnapshot(`1`);
        });
      });
    });

    test("return open event types", async () => {
      await cds.tx({}, async (tx) => {
        await testHelper.insertEventEntry(tx);
        await checkAndInsertPeriodicEvents(tx.context);
        const result = await getOpenQueueEntries(tx);
        expect(result.length).toMatchInlineSnapshot(`5`); // 1 ad-hoc and 4 periodic
        expect(result).toMatchSnapshot();
      });
    });

    test("event types in progress should be ignored", async () => {
      await cds.tx({}, async (tx) => {
        await testHelper.insertEventEntry(tx);
        await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ status: EventProcessingStatus.InProgress }));
        await checkAndInsertPeriodicEvents(tx.context);
        const result = await getOpenQueueEntries(tx);
        expect(result.length).toMatchInlineSnapshot(`4`); // periodic
        expect(result).toMatchSnapshot();
      });
    });

    test("event types in error should be considered", async () => {
      await cds.tx({}, async (tx) => {
        await testHelper.insertEventEntry(tx);
        await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ status: EventProcessingStatus.Error }));
        await checkAndInsertPeriodicEvents(tx.context);
        const result = await getOpenQueueEntries(tx);
        expect(result.length).toMatchInlineSnapshot(`5`); // 1 ad-hoc and 4 periodic
        expect(result).toMatchSnapshot();
      });
    });

    test("should ignore not existing types", async () => {
      await cds.tx({}, async (tx) => {
        await testHelper.insertEventEntry(tx);
        await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ type: "123" }));
        const result = await getOpenQueueEntries(tx);
        expect(result.length).toMatchInlineSnapshot(`0`);
      });
    });

    test("should work for CAP Service that is not connected yet", async () => {
      const connectToSpy = jest.spyOn(cds.connect, "to").mockResolvedValueOnce({ name: "NotificationService" });
      cds.requires.NotificationService = {};
      await cds.tx({}, async (tx) => {
        await testHelper.insertEventEntry(tx);
        await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ type: "CAP_OUTBOX", subType: "NotificationService" }));
        const result = await getOpenQueueEntries(tx);
        expect(connectToSpy).toHaveBeenCalledTimes(1);
        expect(result.length).toMatchInlineSnapshot(`1`);
        delete cds.requires.NotificationService;
      });
    });

    test("should work for CAP Service that is not connected yet use connect as fallback should work", async () => {
      const connectToSpy = jest.spyOn(cds.connect, "to").mockResolvedValueOnce({ name: "NotificationService" });
      await cds.tx({}, async (tx) => {
        await testHelper.insertEventEntry(tx);
        await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ type: "CAP_OUTBOX", subType: "NotificationService" }));
        const result = await getOpenQueueEntries(tx);
        expect(result.length).toMatchInlineSnapshot(`1`);
        expect(connectToSpy).toHaveBeenCalledTimes(1);
      });
    });

    test("if connect to CAP service is not possible event should be ignored", async () => {
      const connectToSpy = jest.spyOn(cds.connect, "to").mockRejectedValueOnce(new Error("connect not possible"));
      await cds.tx({}, async (tx) => {
        await testHelper.insertEventEntry(tx);
        await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ type: "CAP_OUTBOX", subType: "NotificationService" }));
        const result = await getOpenQueueEntries(tx);
        expect(result.length).toMatchInlineSnapshot(`0`);
        expect(connectToSpy).toHaveBeenCalledTimes(1);
      });
    });

    test("no events - should nothing be open", async () => {
      await cds.tx({}, async (tx) => {
        const result = await getOpenQueueEntries(tx);
        expect(result.length).toMatchInlineSnapshot(`0`);
      });
    });

    describe("should respect app name configuration", () => {
      afterAll(() => {
        const env = getEnvInstance();
        env.vcapApplication = {};
      });

      test("one open event for app and one not for this app", async () => {
        await cds.tx({}, async (tx) => {
          await testHelper.insertEventEntry(tx, { randomGuid: true });
          await testHelper.insertEventEntry(tx, { type: "AppSpecific", subType: "AppA" });
          const result = await getOpenQueueEntries(tx);
          expect(result.length).toMatchInlineSnapshot(`1`); // 1 ad-hoc and one not relevant
          expect(result).toMatchSnapshot();
        });
      });

      test("one open event for app and one not for this app but redis should ignore filter", async () => {
        await cds.tx({}, async (tx) => {
          await testHelper.insertEventEntry(tx, { randomGuid: true });
          await testHelper.insertEventEntry(tx, { type: "AppSpecific", subType: "AppName" });
          const result = await getOpenQueueEntries(tx, false);
          expect(result.length).toMatchInlineSnapshot(`2`); // 1 ad-hoc and one not relevant
          expect(result).toMatchSnapshot();
        });
      });

      test("both open event relevant for app", async () => {
        await cds.tx({}, async (tx) => {
          await testHelper.insertEventEntry(tx, { randomGuid: true });
          await testHelper.insertEventEntry(tx, { type: "AppSpecific", subType: "AppName" });
          const env = getEnvInstance();
          env.vcapApplication = { application_name: "app-a" };
          const result = await getOpenQueueEntries(tx);
          expect(result.length).toMatchInlineSnapshot(`2`); // 2 ad-hoc both relevant
          expect(result).toMatchSnapshot();
        });
      });

      test("CAP service published event not relevant for app", async () => {
        const service = await cds.connect.to("NotificationService");
        cds.outboxed(service, { appNames: ["app-b"] });
        await cds.tx({}, async (tx) => {
          await testHelper.insertEventEntry(tx);
          await tx.run(
            UPDATE.entity("sap.eventqueue.Event").set({ type: "CAP_OUTBOX", subType: "NotificationService" })
          );
          const result = await getOpenQueueEntries(tx);
          expect(result.length).toMatchInlineSnapshot(`0`);
        });
      });

      test("CAP service published event relevant for app", async () => {
        const env = getEnvInstance();
        env.vcapApplication = { application_name: "app-b" };
        const service = await cds.connect.to("NotificationService");
        cds.outboxed(service, { appNames: ["app-b"] });
        await cds.tx({}, async (tx) => {
          await testHelper.insertEventEntry(tx);
          await tx.run(
            UPDATE.entity("sap.eventqueue.Event").set({ type: "CAP_OUTBOX", subType: "NotificationService" })
          );
          const result = await getOpenQueueEntries(tx);
          expect(result.length).toMatchInlineSnapshot(`1`);
        });
      });
    });

    describe("should respect app instance configuration", () => {
      afterAll(() => {
        const env = getEnvInstance();
        env.applicationInstance = null;
      });

      test("one open event for app and one not for this app", async () => {
        await cds.tx({}, async (tx) => {
          await testHelper.insertEventEntry(tx, { randomGuid: true });
          await testHelper.insertEventEntry(tx, { type: "AppSpecific", subType: "AppInstance" });
          const result = await getOpenQueueEntries(tx);
          expect(result.length).toMatchInlineSnapshot(`1`); // 1 ad-hoc and one not relevant
          expect(result).toMatchSnapshot();
        });
      });

      test("one open event for app and one not for this app but redis should ignore filter", async () => {
        await cds.tx({}, async (tx) => {
          await testHelper.insertEventEntry(tx, { randomGuid: true });
          await testHelper.insertEventEntry(tx, { type: "AppSpecific", subType: "AppInstance" });
          const result = await getOpenQueueEntries(tx, false);
          expect(result.length).toMatchInlineSnapshot(`2`); // 1 ad-hoc and one not relevant
          expect(result).toMatchSnapshot();
        });
      });

      test("both open event relevant for app", async () => {
        await cds.tx({}, async (tx) => {
          await testHelper.insertEventEntry(tx, { randomGuid: true });
          await testHelper.insertEventEntry(tx, { type: "AppSpecific", subType: "AppInstance" });
          const env = getEnvInstance();
          env.applicationInstance = 1;
          const result = await getOpenQueueEntries(tx);
          expect(result.length).toMatchInlineSnapshot(`2`); // 2 ad-hoc both relevant
          expect(result).toMatchSnapshot();
        });
      });

      test("CAP service published event not relevant for app", async () => {
        const service = await cds.connect.to("NotificationService");
        cds.outboxed(service, { appInstances: [0] });
        await cds.tx({}, async (tx) => {
          await testHelper.insertEventEntry(tx);
          await tx.run(
            UPDATE.entity("sap.eventqueue.Event").set({ type: "CAP_OUTBOX", subType: "NotificationService" })
          );
          const result = await getOpenQueueEntries(tx);
          expect(result.length).toMatchInlineSnapshot(`0`);
        });
      });

      test("CAP service published event relevant for app", async () => {
        const env = getEnvInstance();
        env.applicationInstance = 1;
        const service = await cds.connect.to("NotificationService");
        cds.outboxed(service, { appInstances: [1] });
        await cds.tx({}, async (tx) => {
          await testHelper.insertEventEntry(tx);
          await tx.run(
            UPDATE.entity("sap.eventqueue.Event").set({ type: "CAP_OUTBOX", subType: "NotificationService" })
          );
          const result = await getOpenQueueEntries(tx);
          expect(result.length).toMatchInlineSnapshot(`1`);
        });
      });
    });
  });

  describe("app specific apps", () => {
    describe("appName", () => {
      describe("should not process", () => {
        test("ad-hoc event", async () => {
          const event = eventQueue.config.events.find((event) => event.subType === "AppName");
          await cds.tx({}, async (tx) => {
            await testHelper.insertEventEntry(tx, { type: event.type, subType: event.subType });
          });
          await eventQueue.processEventQueue(context, event.type, event.subType);
          expect(loggerMock.callsLengths().error).toEqual(0);
          await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectOpen(tx));
        });

        test("periodic event", async () => {
          const event = eventQueue.config.periodicEvents.find((event) => event.subType === "AppName");
          await cds.tx({}, (tx) => checkAndInsertPeriodicEvents(tx.context));
          await eventQueue.processEventQueue(context, event.type, event.subType);
          await cds.tx({}, async (tx) => {
            await testHelper.selectEventQueueAndExpectOpen(tx, { type: event.type, subType: event.subType });
          });
          expect(loggerMock.callsLengths().error).toEqual(0);
        });
      });

      describe("should process", () => {
        beforeAll(() => {
          const env = getEnvInstance();
          env.vcapApplication = { application_name: "app-a" };
        });

        test("ad-hoc event", async () => {
          const event = eventQueue.config.events.find((event) => event.subType === "AppName");
          await cds.tx({}, async (tx) => {
            await testHelper.insertEventEntry(tx, { type: event.type, subType: event.subType });
          });
          await eventQueue.processEventQueue(context, event.type, event.subType);
          expect(loggerMock.callsLengths().error).toEqual(0);
          await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectDone(tx));
        });

        test("periodic event", async () => {
          const event = eventQueue.config.periodicEvents.find((event) => event.subType === "AppName");
          await cds.tx({}, (tx) => checkAndInsertPeriodicEvents(tx.context));
          await eventQueue.processEventQueue(context, event.type, event.subType);
          expect(loggerMock.callsLengths().error).toEqual(0);
          const events = await cds.tx({}, (tx) =>
            testHelper.selectEventQueueAndReturn(tx, {
              expectedLength: 2,
              subType: event.subType,
            })
          );
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
      });
    });

    describe("appInstance", () => {
      describe("should not process", () => {
        test("ad-hoc event", async () => {
          const event = eventQueue.config.events.find((event) => event.subType === "AppInstance");
          await cds.tx({}, async (tx) => {
            await testHelper.insertEventEntry(tx, { type: event.type, subType: event.subType });
          });
          await eventQueue.processEventQueue(context, event.type, event.subType);
          expect(loggerMock.callsLengths().error).toEqual(0);
          await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectOpen(tx));
        });

        test("periodic event", async () => {
          const event = eventQueue.config.periodicEvents.find((event) => event.subType === "AppInstance");
          await cds.tx({}, (tx) => checkAndInsertPeriodicEvents(tx.context));
          await eventQueue.processEventQueue(context, event.type, event.subType);
          await cds.tx({}, async (tx) => {
            await testHelper.selectEventQueueAndExpectOpen(tx, { type: event.type, subType: event.subType });
          });
          expect(loggerMock.callsLengths().error).toEqual(0);
        });
      });

      describe("should process", () => {
        beforeAll(() => {
          const env = getEnvInstance();
          env.applicationInstance = [1];
        });

        test("ad-hoc event", async () => {
          const event = eventQueue.config.events.find((event) => event.subType === "AppInstance");
          await cds.tx({}, async (tx) => {
            await testHelper.insertEventEntry(tx, { type: event.type, subType: event.subType });
          });
          await eventQueue.processEventQueue(context, event.type, event.subType);
          expect(loggerMock.callsLengths().error).toEqual(0);
          await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectDone(tx));
        });

        test("periodic event", async () => {
          const event = eventQueue.config.periodicEvents.find((event) => event.subType === "AppInstance");
          await cds.tx({}, (tx) => checkAndInsertPeriodicEvents(tx.context));
          await eventQueue.processEventQueue(context, event.type, event.subType);
          expect(loggerMock.callsLengths().error).toEqual(0);
          const events = await cds.tx({}, (tx) =>
            testHelper.selectEventQueueAndReturn(tx, {
              expectedLength: 2,
              subType: event.subType,
            })
          );
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
      });
    });

    describe("combination", () => {
      describe("should not process", () => {
        test("ad-hoc event - appName matches but appInstance not", async () => {
          const env = getEnvInstance();
          env.vcapApplication = { application_name: "app-a" };
          env.applicationInstance = [2];
          const event = eventQueue.config.events.find((event) => event.subType === "both");
          await cds.tx({}, async (tx) => {
            await testHelper.insertEventEntry(tx, { type: event.type, subType: event.subType });
          });
          await eventQueue.processEventQueue(context, event.type, event.subType);
          expect(loggerMock.callsLengths().error).toEqual(0);
          await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectOpen(tx));
        });

        test("ad-hoc event - appName doesn't match but appInstance does", async () => {
          const env = getEnvInstance();
          env.vcapApplication = { application_name: "app-b" };
          env.applicationInstance = [1];
          const event = eventQueue.config.events.find((event) => event.subType === "both");
          await cds.tx({}, async (tx) => {
            await testHelper.insertEventEntry(tx, { type: event.type, subType: event.subType });
          });
          await eventQueue.processEventQueue(context, event.type, event.subType);
          expect(loggerMock.callsLengths().error).toEqual(0);
          await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectOpen(tx));
        });

        test("periodic event - appName matches but appInstance not", async () => {
          const env = getEnvInstance();
          env.vcapApplication = { application_name: "app-b" };
          env.applicationInstance = [1];
          const event = eventQueue.config.periodicEvents.find((event) => event.subType === "both");
          await cds.tx({}, (tx) => checkAndInsertPeriodicEvents(tx.context));
          await eventQueue.processEventQueue(context, event.type, event.subType);
          await cds.tx({}, async (tx) => {
            await testHelper.selectEventQueueAndExpectOpen(tx, { type: event.type, subType: event.subType });
          });
          expect(loggerMock.callsLengths().error).toEqual(0);
        });

        test("periodic event - appName doesn't match but appInstance does", async () => {
          const env = getEnvInstance();
          env.vcapApplication = { application_name: "app-a" };
          env.applicationInstance = [2];
          const event = eventQueue.config.periodicEvents.find((event) => event.subType === "both");
          await cds.tx({}, (tx) => checkAndInsertPeriodicEvents(tx.context));
          await eventQueue.processEventQueue(context, event.type, event.subType);
          await cds.tx({}, async (tx) => {
            await testHelper.selectEventQueueAndExpectOpen(tx, { type: event.type, subType: event.subType });
          });
          expect(loggerMock.callsLengths().error).toEqual(0);
        });
      });

      describe("should process", () => {
        beforeAll(() => {
          const env = getEnvInstance();
          env.vcapApplication = { application_name: "app-a" };
          env.applicationInstance = [1];
        });

        test("ad-hoc event", async () => {
          const event = eventQueue.config.events.find((event) => event.subType === "both");
          await cds.tx({}, (tx) => testHelper.insertEventEntry(tx, { type: event.type, subType: event.subType }));
          await eventQueue.processEventQueue(context, event.type, event.subType);
          expect(loggerMock.callsLengths().error).toEqual(0);
          await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectDone(tx));
        });

        test("periodic event", async () => {
          const event = eventQueue.config.periodicEvents.find((event) => event.subType === "both");
          await cds.tx({}, (tx) => checkAndInsertPeriodicEvents(tx.context));
          await eventQueue.processEventQueue(context, event.type, event.subType);
          expect(loggerMock.callsLengths().error).toEqual(0);
          const events = await cds.tx({}, (tx) =>
            testHelper.selectEventQueueAndReturn(tx, {
              expectedLength: 2,
              subType: event.subType,
            })
          );
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
      });
    });
  });
});
