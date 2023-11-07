"use strict";

const path = require("path");

const cds = require("@sap/cds/lib");

const cdsHelper = require("../src/shared/cdsHelper");
const executeInNewTransactionSpy = jest.spyOn(cdsHelper, "executeInNewTransaction");

const eventQueue = require("../src");
const eventScheduler = require("../src/shared/EventScheduler");
const testHelper = require("./helper");
const EventQueueTest = require("./asset/EventQueueTest");
const { Logger: mockLogger } = require("./mocks/logger");

const project = __dirname + "/.."; // The project's root folder
cds.test(project);

describe("baseFunctionality", () => {
  let context, tx, loggerMock;

  executeInNewTransactionSpy.mockImplementation(
    // eslint-disable-next-line no-unused-vars
    async (context = {}, transactionTag, fn) => {
      try {
        return await fn(tx);
      } catch (err) {
        if (!(err instanceof cdsHelper.TriggerRollback)) {
          throw err;
        }
      }
    }
  );

  beforeAll(async () => {
    const configFilePath = path.join(__dirname, "asset", "config.yml");
    await eventQueue.initialize({
      configFilePath,
      processEventsAfterPublish: false,
      registerAsEventProcessor: false,
    });
    loggerMock = mockLogger();
    jest.spyOn(cds, "log").mockImplementation((layer) => {
      return mockLogger(layer);
    });
  });

  beforeEach(async () => {
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
    await tx.run(DELETE.from("sap.eventqueue.Lock"));
    await tx.run(DELETE.from("sap.eventqueue.Event"));
  });

  afterEach(async () => {
    await tx.rollback();
    jest.clearAllMocks();
  });

  afterAll(() => cds.shutdown);

  test("empty queue - nothing to do", async () => {
    const event = eventQueue.getConfigInstance().events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
  });

  test("insert one entry and process", async () => {
    await testHelper.insertEventEntry(tx);
    const event = eventQueue.getConfigInstance().events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectDone(tx);
  });

  test("insert one delayed entry - should not directly be processed", async () => {
    await testHelper.insertEventEntry(tx, { delayedSeconds: 15 });
    const event = eventQueue.getConfigInstance().events[0];
    const eventSchedulerInstance = eventScheduler.getInstance();
    const eventSchedulerSpy = jest.spyOn(eventSchedulerInstance, "scheduleEvent").mockReturnValue();
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectOpen(tx);
    expect(eventSchedulerSpy).toHaveBeenCalledTimes(1);
  });

  test("insert one delayed entry after runInterval", async () => {
    await testHelper.insertEventEntry(tx, { delayedSeconds: 500 });
    const event = eventQueue.getConfigInstance().events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectOpen(tx);
  });

  test("should do nothing if no lock is available", async () => {
    await testHelper.insertEventEntry(tx);
    jest.spyOn(eventQueue.EventQueueProcessorBase.prototype, "handleDistributedLock").mockResolvedValueOnce(false);
    const event = eventQueue.getConfigInstance().events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectOpen(tx);
  });

  describe("error handling", () => {
    test("missing event implementation", async () => {
      await testHelper.insertEventEntry(tx);
      await eventQueue.processEventQueue(context, "404", "NOT FOUND");
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
      await testHelper.selectEventQueueAndExpectOpen(tx);
    });

    test("handle handleDistributedLock fails", async () => {
      await testHelper.insertEventEntry(tx);
      jest
        .spyOn(eventQueue.EventQueueProcessorBase.prototype, "handleDistributedLock")
        .mockRejectedValueOnce(new Error("lock require failed"));
      const event = eventQueue.getConfigInstance().events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
      await testHelper.selectEventQueueAndExpectOpen(tx);
    });

    test("handle getQueueEntriesAndSetToInProgress fails", async () => {
      await testHelper.insertEventEntry(tx);
      jest
        .spyOn(eventQueue.EventQueueProcessorBase.prototype, "getQueueEntriesAndSetToInProgress")
        .mockRejectedValueOnce(new Error("db error"));
      const event = eventQueue.getConfigInstance().events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
      await testHelper.selectEventQueueAndExpectOpen(tx);
    });

    test("handle modifyQueueEntry fails", async () => {
      await testHelper.insertEventEntry(tx);
      jest.spyOn(eventQueue.EventQueueProcessorBase.prototype, "modifyQueueEntry").mockImplementationOnce(() => {
        throw new Error("syntax error");
      });
      const event = eventQueue.getConfigInstance().events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
      await testHelper.selectEventQueueAndExpectError(tx);
    });

    test("handle checkEventAndGeneratePayload fails", async () => {
      await testHelper.insertEventEntry(tx);
      jest
        .spyOn(EventQueueTest.prototype, "checkEventAndGeneratePayload")
        .mockRejectedValueOnce(new Error("syntax error"));
      const event = eventQueue.getConfigInstance().events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
      await testHelper.selectEventQueueAndExpectError(tx);
    });

    test("handle clusterQueueEntries fails", async () => {
      await testHelper.insertEventEntry(tx);
      jest.spyOn(eventQueue.EventQueueProcessorBase.prototype, "clusterQueueEntries").mockImplementationOnce(() => {
        throw new Error("syntax error");
      });
      const event = eventQueue.getConfigInstance().events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
      await testHelper.selectEventQueueAndExpectError(tx);
    });

    test("undefined payload should be processed", async () => {
      const eventQueueEntry = testHelper.getEventEntry();
      eventQueueEntry.payload = undefined;
      jest
        .spyOn(EventQueueTest.prototype, "checkEventAndGeneratePayload")
        .mockImplementationOnce(async (queueEntry) => {
          return queueEntry.payload;
        });
      await tx.run(INSERT.into("sap.eventqueue.Event").entries(eventQueueEntry));
      const event = eventQueue.getConfigInstance().events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectDone(tx);
    });

    test("null as payload should be set to done", async () => {
      const eventQueueEntry = testHelper.getEventEntry();
      eventQueueEntry.payload = undefined;
      jest.spyOn(EventQueueTest.prototype, "checkEventAndGeneratePayload").mockImplementationOnce(async () => {
        return null;
      });
      await tx.run(INSERT.into("sap.eventqueue.Event").entries(eventQueueEntry));
      const event = eventQueue.getConfigInstance().events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectDone(tx);
    });

    test("undefined as payload should be treated as error", async () => {
      const eventQueueEntry = testHelper.getEventEntry();
      eventQueueEntry.payload = undefined;
      jest.spyOn(EventQueueTest.prototype, "checkEventAndGeneratePayload").mockImplementationOnce(async () => {
        return undefined;
      });
      await tx.run(INSERT.into("sap.eventqueue.Event").entries(eventQueueEntry));
      const event = eventQueue.getConfigInstance().events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      await testHelper.selectEventQueueAndExpectError(tx);
    });
  });

  describe("insert events", () => {
    test("straight forward", async () => {
      const event = eventQueue.getConfigInstance().events[0];
      await eventQueue.publishEvent(tx, {
        type: event.type,
        subType: event.subType,
        payload: JSON.stringify({
          testPayload: 123,
        }),
        startAfter: new Date(1699344489697),
      });
      const events = await tx.run(SELECT.from("sap.eventqueue.Event"));
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

    test("not a proper date", async () => {
      const event = eventQueue.getConfigInstance().events[0];
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
