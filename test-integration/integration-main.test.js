"use strict";

const path = require("path");

const cds = require("@sap/cds");
cds.test(__dirname + "/_env");
const cdsHelper = require("../src/shared/cdsHelper");
jest.spyOn(cdsHelper, "getAllTenantIds").mockResolvedValue(null);

const eventQueue = require("../src");
const runners = require("../src/runner/runner");
jest.spyOn(runners, "singleTenantDb").mockResolvedValue();
const testHelper = require("../test/helper");
const EventQueueTest = require("../test/asset/EventQueueTest");
const { EventProcessingStatus, EventQueueProcessorBase } = require("../src");
const { Logger: mockLogger } = require("../test/mocks/logger");
const distributedLock = require("../src/shared/distributedLock");
const eventScheduler = require("../src/shared/eventScheduler");
const { processEventQueue } = require("../src/processEventQueue");
const periodicEvents = require("../src/periodicEvents");

const configFilePath = path.join(__dirname, "..", "./test", "asset", "config.yml");

let dbCounts = {};
describe("integration-main", () => {
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

  it("empty queue - nothing to do", async () => {
    const event = eventQueue.config.events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 0 });
    expect(loggerMock.calls().error).toEqual([]);
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
    await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
    expect(dbCounts).toMatchSnapshot();
  });

  it("stock event should be processed again", async () => {
    const event = testHelper.getEventEntry();
    await cds.tx({}, async (tx2) => {
      await tx2.run(
        INSERT.into("sap.eventqueue.Event").entries({
          ...event,
          status: 1,
          lastAttemptTimestamp: new Date(Date.now() - 4 * 60 * 1000),
          attempts: 1,
          namespace: "default",
        })
      );
    });
    const scheduleNextSpy = jest.spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent");

    await processEventQueue(context, event.type, event.subType);

    expect(scheduleNextSpy).toHaveBeenCalledTimes(0);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectDone(tx);

    await processEventQueue(context, event.type, event.subType);
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
    await testHelper.selectEventQueueAndExpectExceeded(tx, { expectedLength: 1 });
    expect(dbCounts).toMatchSnapshot();
    dbCounts = {};
    expect(processSpy).toHaveBeenCalledTimes(1);

    // Event should not be processed anymore
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectExceeded(tx, { expectedLength: 1 });
    expect(dbCounts).toMatchSnapshot();
    expect(processSpy).toHaveBeenCalledTimes(1);
  });

  it("should do nothing if lock for event combination cannot be acquired", async () => {
    const event = eventQueue.config.events[0];
    await cds.tx({}, async (tx2) => {
      await testHelper.insertEventEntry(tx2);
      await distributedLock.acquireLock(tx2.context, ["default", event.type, event.subType].join("##"));
    });
    dbCounts = {};
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
    expect(dbCounts).toMatchSnapshot();
  });

  it("should set db user correctly", async () => {
    const event = eventQueue.config.events.find((e) => e.subType === "isolated");
    await cds.tx({}, async (tx2) => {
      await testHelper.insertEventEntry(tx2, { type: "TransactionMode", subType: "isolated" });
    });
    dbCounts = {};
    const id = cds.utils.uuid();
    jest.spyOn(EventQueueTest.prototype, "processEvent").mockImplementation(async function (_, key, queueEntries) {
      await this.getTxForEventProcessing(key).run(
        INSERT.into("sap.eventqueue.Lock").entries({
          code: id,
        })
      );
      return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
    });
    eventQueue.config.userId = "badman";
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await cds.tx({}, async (tx2) => {
      const { createdBy } = await tx2.run(SELECT.one.from("sap.eventqueue.Lock").where({ code: id }));
      expect(createdBy).toEqual("badman");
    });
    await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
    expect(dbCounts).toMatchSnapshot();
    eventQueue.config.dbUser = null;
  });

  it("insert one entry - checkForNext but return status 0", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    dbCounts = {};
    const event = eventQueue.config.events[0];
    event.checkForNextChunk = true;
    const processSpy = jest
      .spyOn(EventQueueTest.prototype, "processEvent")
      .mockImplementation((_, __, queueEntries) =>
        queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Open])
      );
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(processSpy).toHaveBeenCalledTimes(1);
    await testHelper.selectEventQueueAndExpectOpen(tx);
    const [openEvent] = await testHelper.selectEventQueueAndReturn(tx);
    expect(openEvent.startAfter).toEqual(null);
    expect(dbCounts).toMatchSnapshot();

    jest.spyOn(EventQueueTest.prototype, "processEvent").mockRestore();
    event.checkForNextChunk = false;
  });

  it("if processing time is exceeded broadcast should trigger processing again", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    dbCounts = {};
    const event = eventQueue.config._rawEventMap[["default", "Notifications", "Task"].join("##")];
    event.checkForNextChunk = true;
    const scheduler = jest.spyOn(eventScheduler.getInstance(), "scheduleEvent").mockReturnValueOnce(null);
    const processSpy = jest
      .spyOn(EventQueueTest.prototype, "processEvent")
      .mockImplementation(async function (processContext, __, queueEntries) {
        await testHelper.insertEventEntry(cds.tx(processContext), {
          numberOfEntries: 1,
          type: this.eventType,
          subType: this.subEventType,
          randomGuid: true,
        });
        this.eventConfig.startTime = new Date(Date.now() - eventQueue.config.runInterval);
        return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Done]);
      });
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(scheduler).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledTimes(1);
    await testHelper.selectEventQueueAndExpectDone(tx);
    expect(dbCounts).toMatchSnapshot();

    jest.spyOn(EventQueueTest.prototype, "processEvent").mockRestore();
    event.checkForNextChunk = false;
  });

  it("register retry for failed event after configured interval", async () => {
    const type = "Test";
    const subType = "retryFailedAfter";
    await cds.tx({}, (tx2) =>
      testHelper.insertEventEntry(tx2, {
        type,
        subType,
      })
    );
    dbCounts = {};
    const scheduler = jest.spyOn(eventScheduler.getInstance(), "scheduleEvent").mockReturnValueOnce(null);
    const { retryFailedAfter } = eventQueue.config.getEventConfig(type, subType);
    jest
      .spyOn(EventQueueTest.prototype, "processEvent")
      .mockImplementationOnce(async (processContext, key, queueEntries) => {
        return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Error]);
      });
    await eventQueue.processEventQueue(context, type, subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    const [event] = await testHelper.selectEventQueueAndReturn(tx);
    expect(event.status).toEqual(EventProcessingStatus.Error);
    expect(new Date(Date.now() + retryFailedAfter) - new Date(event.startAfter)).toBeLessThan(5000); // diff should be lower than 1 second
    expect(scheduler).toHaveBeenCalledTimes(1);
    expect(dbCounts).toMatchSnapshot();
  });

  it("register retry for failed event after default interval", async () => {
    const type = "Test";
    const subType = "NoProcessAfterCommit";
    await cds.tx({}, (tx2) =>
      testHelper.insertEventEntry(tx2, {
        type,
        subType,
      })
    );
    dbCounts = {};
    const scheduler = jest.spyOn(eventScheduler.getInstance(), "scheduleEvent").mockReturnValueOnce(null);
    jest
      .spyOn(EventQueueTest.prototype, "processEvent")
      .mockImplementationOnce(async (processContext, key, queueEntries) => {
        return queueEntries.map((queueEntry) => [queueEntry.ID, EventProcessingStatus.Error]);
      });
    await eventQueue.processEventQueue(context, type, subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    const [event] = await testHelper.selectEventQueueAndReturn(tx);
    expect(event.status).toEqual(EventProcessingStatus.Error);
    expect(new Date(Date.now() + 5 * 60 * 1000) - new Date(event.startAfter)).toBeLessThan(5000); // diff should be lower than 1 second
    expect(scheduler).toHaveBeenCalledTimes(1);
    expect(dbCounts).toMatchSnapshot();
  });
});
