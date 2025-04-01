"use strict";

const path = require("path");
const { promisify } = require("util");

const cds = require("@sap/cds");
const { CronExpressionParser } = require("cron-parser");
cds.test(__dirname + "/_env");
const cdsHelper = require("../src/shared/cdsHelper");
jest.spyOn(cdsHelper, "getAllTenantIds").mockResolvedValue(null);

const eventQueue = require("../src");
const runners = require("../src/runner/runner");
jest.spyOn(runners, "singleTenantDb").mockResolvedValue();
const testHelper = require("../test/helper");
const EventQueueTest = require("../test/asset/EventQueueTest");
const EventQueueHealthCheckDb = require("../test/asset/EventQueueHealthCheckDb");
const { EventProcessingStatus, EventQueueProcessorBase } = require("../src");
const { Logger: mockLogger } = require("../test/mocks/logger");
const eventScheduler = require("../src/shared/eventScheduler");
const { processEventQueue } = require("../src/processEventQueue");
const periodicEventsTest = require("../src/periodicEvents");

const configFilePath = path.join(__dirname, "..", "./test", "asset", "config.yml");

let dbCounts = {};
describe("periodic events", () => {
  let context;
  let tx;
  let loggerMock;
  let checkAndInsertPeriodicEventsMock;

  beforeAll(async () => {
    checkAndInsertPeriodicEventsMock = jest
      .spyOn(periodicEventsTest, "checkAndInsertPeriodicEvents")
      .mockResolvedValue();
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

  describe("interval events", () => {
    it("insert and process - should call schedule next", async () => {
      const event = eventQueue.config.periodicEvents[0];
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();

      await processEventQueue(context, event.type, event.subType);

      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectDone(tx, { type: "HealthCheck_PERIODIC" });
    });

    it("exception should be handled and no retry should be done", async () => {
      const event = eventQueue.config.periodicEvents[0];
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();
      const processPeriodicEventSpy = jest
        .spyOn(EventQueueHealthCheckDb.prototype, "processPeriodicEvent")
        .mockRejectedValueOnce(new Error("failed"));

      await processEventQueue(context, event.type, event.subType);

      expect(processPeriodicEventSpy).toHaveBeenCalledTimes(1);
      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(1);
      await testHelper.selectEventQueueAndExpectError(tx, { type: "HealthCheck_PERIODIC" });

      await processEventQueue(context, event.type, event.subType);
      expect(processPeriodicEventSpy).toHaveBeenCalledTimes(1);
    });

    it("stock periodic events should be set to error", async () => {
      const event = eventQueue.config.periodicEvents[0];
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
        await tx2.run(
          UPDATE.entity("sap.eventqueue.Event").set({
            status: 1,
            lastAttemptTimestamp: new Date(Date.now() - 4 * 60 * 1000),
            attempts: 1,
          })
        );
      });
      const scheduleNextSpy = jest.spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent");
      const processPeriodicEventSpy = jest.spyOn(EventQueueHealthCheckDb.prototype, "processPeriodicEvent");

      await processEventQueue(context, event.type, event.subType);

      expect(processPeriodicEventSpy).toHaveBeenCalledTimes(0);
      expect(scheduleNextSpy).toHaveBeenCalledTimes(0);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectError(tx, { type: "HealthCheck_PERIODIC" });

      await processEventQueue(context, event.type, event.subType);
      expect(processPeriodicEventSpy).toHaveBeenCalledTimes(0);
    });

    it("insert process - should handle if the event is already running - execute anyway", async () => {
      const event = eventQueue.config.periodicEvents[0];
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);

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
      const events = await testHelper.selectEventQueueAndReturn(tx, {
        expectedLength: 2,
        type: "HealthCheck_PERIODIC",
      });
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
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
        await tx2.run(
          UPDATE.entity("sap.eventqueue.Event").set({
            startAfter: newDate,
          })
        );
      });
      const scheduleNextSpy = jest.spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent");

      await processEventQueue(context, event.type, event.subType);

      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(scheduleNextSpy).toHaveBeenCalledTimes(2);
      const events = await testHelper.selectEventQueueAndReturn(tx, {
        expectedLength: 3,
        type: "HealthCheck_PERIODIC",
      });
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
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
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
      const events = await testHelper.selectEventQueueAndReturn(tx, {
        expectedLength: 2,
        type: "HealthCheck_PERIODIC",
      });
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
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
      });

      await processEventQueue(context, event.type, event.subType);

      expect(scheduleEventSpy).toHaveBeenCalledTimes(1);
      expect(scheduleEventSpy.mock.calls[0]).toEqual([undefined, "HealthCheck_PERIODIC", "DB", expect.anything()]);
      expect(loggerMock.callsLengths().error).toEqual(0);
      const events = await testHelper.selectEventQueueAndReturn(tx, {
        expectedLength: 2,
        type: "HealthCheck_PERIODIC",
      });
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

    it("insert one delayed entry and process - should be processed after timeout", async () => {
      await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2, { delayedSeconds: 5 }));
      const event = eventQueue.config.events[0];
      eventQueue.config.isEventQueueActive = true;
      eventQueue.config.registerAsEventProcessor = true;
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectOpen(tx);
      await waitEntryIsDone();
      await testHelper.selectEventQueueAndExpectDone(tx);
      eventQueue.config.registerAsEventProcessor = false;
      eventQueue.config.isEventQueueActive = false;
    });
  });

  describe("cron events", () => {
    let cronEvent;
    beforeAll(() => {
      cronEvent = eventQueue.config.periodicEvents.find((e) => e.cron);
    });

    it("insert and process - should call schedule next", async () => {
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
        await _setCronEventToNow(tx2, cronEvent);
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();

      await processEventQueue(context, cronEvent.type, cronEvent.subType);

      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectDone(tx, { type: cronEvent.type });
    });

    it("cron every five minute", async () => {
      cronEvent = eventQueue.config.periodicEvents.find((e) => e.cron === "*/5 * * * *");
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
        await _setCronEventToNow(tx2, cronEvent);
      });
      const scheduleNextSpy = jest.spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent");

      await processEventQueue(context, cronEvent.type, cronEvent.subType);

      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      const events = await testHelper.selectEventQueueAndReturn(tx, {
        expectedLength: 2,
        type: cronEvent.type,
      });
      const [done, open] = events.sort((a, b) => new Date(a.startAfter) - new Date(b.startAfter));
      expect(done).toEqual({
        status: EventProcessingStatus.Done,
        attempts: 1,
        startAfter: expect.any(String),
      });
      expect(open).toEqual({
        status: EventProcessingStatus.Open,
        attempts: 0,
        startAfter: CronExpressionParser.parse(cronEvent.cron).next().toISOString(),
      });
    });

    it("exception should be handled and no retry should be done", async () => {
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
        await _setCronEventToNow(tx2, cronEvent);
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();
      const processPeriodicEventSpy = jest
        .spyOn(EventQueueHealthCheckDb.prototype, "processPeriodicEvent")
        .mockRejectedValueOnce(new Error("failed"));

      await processEventQueue(context, cronEvent.type, cronEvent.subType);

      expect(processPeriodicEventSpy).toHaveBeenCalledTimes(1);
      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(1);
      await testHelper.selectEventQueueAndExpectError(tx, { type: cronEvent.type });

      await processEventQueue(context, cronEvent.type, cronEvent.subType);
      expect(processPeriodicEventSpy).toHaveBeenCalledTimes(1);
    });

    it("stock periodic events should be set to error", async () => {
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
        await tx2.run(
          UPDATE.entity("sap.eventqueue.Event").set({
            status: 1,
            lastAttemptTimestamp: new Date(Date.now() - 4 * 60 * 1000),
            attempts: 1,
          })
        );
      });
      const scheduleNextSpy = jest.spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent");
      const processPeriodicEventSpy = jest.spyOn(EventQueueHealthCheckDb.prototype, "processPeriodicEvent");

      await processEventQueue(context, cronEvent.type, cronEvent.subType);

      expect(processPeriodicEventSpy).toHaveBeenCalledTimes(0);
      expect(scheduleNextSpy).toHaveBeenCalledTimes(0);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectError(tx, { type: cronEvent.type });

      await processEventQueue(context, cronEvent.type, cronEvent.subType);
      expect(processPeriodicEventSpy).toHaveBeenCalledTimes(0);
    });

    it("insert process - should handle if the event is already running - execute anyway", async () => {
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
        await _setCronEventToNow(tx2, cronEvent);

        const currentEntry = await tx2.run(SELECT.one.from("sap.eventqueue.Event").where({ type: cronEvent.type }));
        delete currentEntry.ID;
        currentEntry.status = 1;
        currentEntry.attempts = 1;
        await tx2.run(INSERT.into("sap.eventqueue.Event").entries(currentEntry));
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();

      await processEventQueue(context, cronEvent.type, cronEvent.subType);

      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      const events = await testHelper.selectEventQueueAndReturn(tx, {
        expectedLength: 2,
        type: cronEvent.type,
      });
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

    it("if delayed within the next two intervals should schedule next and skip one interval", async () => {
      const newDate = new Date(Date.now() - 65 * 1000);
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
        await tx2.run(
          UPDATE.entity("sap.eventqueue.Event").set({
            startAfter: newDate,
          })
        );
      });
      const scheduleNextSpy = jest.spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent");

      await processEventQueue(context, cronEvent.type, cronEvent.subType);

      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      const events = await testHelper.selectEventQueueAndReturn(tx, {
        expectedLength: 2,
        type: cronEvent.type,
        additionalColumns: ["lastAttemptTimestamp"],
      });
      const [done, open] = events.sort((a, b) => new Date(a.startAfter) - new Date(b.startAfter));
      expect(done).toEqual({
        status: EventProcessingStatus.Done,
        attempts: 1,
        startAfter: newDate.toISOString(),
        lastAttemptTimestamp: expect.any(String),
      });
      expect(open).toEqual({
        status: EventProcessingStatus.Open,
        attempts: 0,
        lastAttemptTimestamp: null,
        startAfter: CronExpressionParser.parse(cronEvent.cron, { currentDate: new Date(done.lastAttemptTimestamp) })
          .next()
          .toISOString(),
      });
    });

    it("if delayed more than next two intervals should schedule next and execute direct - should adjust interval", async () => {
      const newDate = new Date(Date.now() - 180 * 1000);
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
        await tx2.run(
          UPDATE.entity("sap.eventqueue.Event").set({
            startAfter: newDate,
          })
        );
      });
      const scheduleNextSpy = jest.spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent");

      await processEventQueue(context, cronEvent.type, cronEvent.subType);

      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(
        loggerMock.calls().info.find(([log]) => log === "interval adjusted because shifted more than one interval")
      ).toBeFalsy();
      const events = await testHelper.selectEventQueueAndReturn(tx, {
        expectedLength: 2,
        type: cronEvent.type,
      });
      const [done, open] = events.sort((a, b) => new Date(a.startAfter) - new Date(b.startAfter));
      expect(done).toEqual({
        status: EventProcessingStatus.Done,
        attempts: 1,
        startAfter: newDate.toISOString(),
      });
      expect(open).toEqual({
        status: EventProcessingStatus.Open,
        attempts: 0,
        startAfter: CronExpressionParser.parse(cronEvent.cron).next().toISOString(),
      });
    });

    it("insert and process - next event should be scheduled with correct params", async () => {
      const event = eventQueue.config.periodicEvents[0];
      const scheduler = eventScheduler.getInstance();
      const scheduleEventSpy = jest.spyOn(scheduler, "scheduleEvent").mockReturnValueOnce();
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
      });

      await processEventQueue(context, event.type, event.subType);

      expect(scheduleEventSpy).toHaveBeenCalledTimes(1);
      expect(scheduleEventSpy.mock.calls[0]).toEqual([undefined, "HealthCheck_PERIODIC", "DB", expect.anything()]);
      expect(loggerMock.callsLengths().error).toEqual(0);
      const events = await testHelper.selectEventQueueAndReturn(tx, {
        expectedLength: 2,
        type: "HealthCheck_PERIODIC",
      });
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

  describe("transactions modes", () => {
    it("always rollback", async () => {
      const event = eventQueue.config.periodicEvents[0];
      event.transactionMode = "alwaysRollback";
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();

      const idCheck = cds.utils.uuid();
      jest
        .spyOn(EventQueueHealthCheckDb.prototype, "processPeriodicEvent")
        .mockImplementationOnce(async (processContext) => {
          await cds.tx(processContext).run(INSERT.into("sap.eventqueue.Lock").entries({ code: idCheck }));
        });

      dbCounts = {};
      await processEventQueue(context, event.type, event.subType);

      const result = await tx.run(SELECT.one.from("sap.eventqueue.Lock").where({ code: idCheck }));
      expect(result?.code).toBeUndefined();

      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(dbCounts).toMatchSnapshot();

      await testHelper.selectEventQueueAndExpectDone(tx, { type: "HealthCheck_PERIODIC" });
    });

    it("always rollback - use cds.context for db interaction", async () => {
      const event = eventQueue.config.periodicEvents[0];
      event.transactionMode = "alwaysRollback";
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();

      const idCheck = cds.utils.uuid();
      jest.spyOn(EventQueueHealthCheckDb.prototype, "processPeriodicEvent").mockImplementationOnce(async () => {
        await INSERT.into("sap.eventqueue.Lock").entries({ code: idCheck });
      });

      dbCounts = {};
      await processEventQueue(context, event.type, event.subType);

      const result = await tx.run(SELECT.one.from("sap.eventqueue.Lock").where({ code: idCheck }));
      expect(result?.code).toBeUndefined();

      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(dbCounts).toMatchSnapshot();

      await testHelper.selectEventQueueAndExpectDone(tx, { type: "HealthCheck_PERIODIC" });
    });

    it("always commit", async () => {
      const event = eventQueue.config.periodicEvents[0];
      event.transactionMode = "alwaysCommit";
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();

      const idCheck = cds.utils.uuid();
      jest
        .spyOn(EventQueueHealthCheckDb.prototype, "processPeriodicEvent")
        .mockImplementationOnce(async (processContext) => {
          await cds.tx(processContext).run(INSERT.into("sap.eventqueue.Lock").entries({ code: idCheck }));
        });

      dbCounts = {};
      await processEventQueue(context, event.type, event.subType);

      const result = await tx.run(SELECT.one.from("sap.eventqueue.Lock").where({ code: idCheck }));
      expect(result?.code).toEqual(idCheck);

      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(dbCounts).toMatchSnapshot();

      await testHelper.selectEventQueueAndExpectDone(tx, { type: "HealthCheck_PERIODIC" });
    });

    it("always commit - use cds.context for db interaction", async () => {
      const event = eventQueue.config.periodicEvents[0];
      event.transactionMode = "alwaysCommit";
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();

      const idCheck = cds.utils.uuid();
      jest.spyOn(EventQueueHealthCheckDb.prototype, "processPeriodicEvent").mockImplementationOnce(async () => {
        await INSERT.into("sap.eventqueue.Lock").entries({ code: idCheck });
      });

      dbCounts = {};
      await processEventQueue(context, event.type, event.subType);

      const result = await tx.run(SELECT.one.from("sap.eventqueue.Lock").where({ code: idCheck }));
      expect(result?.code).toEqual(idCheck);

      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(dbCounts).toMatchSnapshot();

      await testHelper.selectEventQueueAndExpectDone(tx, { type: "HealthCheck_PERIODIC" });
    });

    it("no tx mode should commit if not exception", async () => {
      const event = eventQueue.config.periodicEvents[0];
      event.transactionMode = null;
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();

      const idCheck = cds.utils.uuid();
      jest
        .spyOn(EventQueueHealthCheckDb.prototype, "processPeriodicEvent")
        .mockImplementationOnce(async (processContext) => {
          await cds.tx(processContext).run(INSERT.into("sap.eventqueue.Lock").entries({ code: idCheck }));
        });

      dbCounts = {};
      await processEventQueue(context, event.type, event.subType);

      const result = await tx.run(SELECT.one.from("sap.eventqueue.Lock").where({ code: idCheck }));
      expect(result?.code).toEqual(idCheck);
      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      expect(dbCounts).toMatchSnapshot();

      await testHelper.selectEventQueueAndExpectDone(tx, { type: "HealthCheck_PERIODIC" });
    });
  });

  describe("delete finished events", () => {
    it("should events which are eligible for deletion -> nothing should be deleted after 30 days", async () => {
      const event = eventQueue.config.periodicEvents.find(({ subType }) => subType === "DELETE_EVENTS");
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
        await tx2.run(
          INSERT.into("sap.eventqueue.Event").entries(
            Array(10)
              .fill({})
              .map(() => ({
                type: eventQueue.config.events[0].type,
                subType: eventQueue.config.events[0].subType,
                lastAttemptTimestamp: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
              }))
          )
        );
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();

      await processEventQueue(context, event.type, event.subType);

      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndReturn(tx, { expectedLength: 18 });
    });

    it("should events which are eligible for deletion -> should be deleted after 7 days", async () => {
      const event = eventQueue.config.periodicEvents.find(({ subType }) => subType === "DELETE_EVENTS");
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
        await tx2.run(
          INSERT.into("sap.eventqueue.Event").entries(
            Array(10)
              .fill({})
              .map(() => ({
                type: eventQueue.config.events[1].type,
                subType: eventQueue.config.events[1].subType,
                lastAttemptTimestamp: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
              }))
          )
        );
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();

      await processEventQueue(context, event.type, event.subType);

      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndReturn(tx, { expectedLength: 8 });
    });
  });

  describe("lastSuccessfulRunTimestamp", () => {
    it("first run should return null", async () => {
      const event = eventQueue.config.periodicEvents[0];
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();

      let lastTs;
      jest.spyOn(EventQueueHealthCheckDb.prototype, "processPeriodicEvent").mockImplementationOnce(async function () {
        lastTs = await this.getLastSuccessfulRunTimestamp();
      });

      await processEventQueue(context, event.type, event.subType);

      expect(lastTs).toEqual(null);
      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectDone(tx, { type: "HealthCheck_PERIODIC" });
    });

    it("second run should return ts of last run", async () => {
      const event = eventQueue.config.periodicEvents[0];
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
      });
      const scheduleNextSpy = jest.spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent");

      let lastTs;
      jest
        .spyOn(EventQueueHealthCheckDb.prototype, "processPeriodicEvent")
        .mockImplementationOnce(async function () {
          lastTs = await this.getLastSuccessfulRunTimestamp();
        })
        .mockImplementationOnce(async function () {
          lastTs = await this.getLastSuccessfulRunTimestamp();
        });

      await processEventQueue(context, event.type, event.subType);
      expect(lastTs).toEqual(null);
      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      const events = await testHelper.selectEventQueueAndReturn(tx, {
        type: "HealthCheck_PERIODIC",
        expectedLength: 2,
        additionalColumns: ["lastAttemptTimestamp"],
      });
      const [open, done] = events.sort((a, b) => a.status - b.status);
      expect(open).toEqual({
        status: EventProcessingStatus.Open,
        attempts: 0,
        startAfter: expect.any(String),
        lastAttemptTimestamp: null,
      });
      expect(done).toEqual({
        status: EventProcessingStatus.Done,
        attempts: 1,
        startAfter: expect.any(String),
        lastAttemptTimestamp: expect.any(String),
      });

      await cds.tx({}, async (tx2) => {
        await tx2.run(
          UPDATE.entity("sap.eventqueue.Event").set({
            startAfter: new Date(),
          })
        );
      });

      jest.spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent").mockResolvedValueOnce();

      await processEventQueue(context, event.type, event.subType);
      expect(new Date(`${lastTs}Z`).toISOString()).toEqual(new Date(done.lastAttemptTimestamp).toISOString());
      expect(scheduleNextSpy).toHaveBeenCalledTimes(2);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("second run should return null if first run failed", async () => {
      const event = eventQueue.config.periodicEvents[0];
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
      });
      const scheduleNextSpy = jest.spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent");

      let lastTs;
      jest
        .spyOn(EventQueueHealthCheckDb.prototype, "processPeriodicEvent")
        .mockImplementationOnce(async function () {
          throw new Error("sth bad happened");
        })
        .mockImplementationOnce(async function () {
          lastTs = await this.getLastSuccessfulRunTimestamp();
        });

      await processEventQueue(context, event.type, event.subType);
      expect(lastTs).toEqual(undefined);
      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(1);
      const events = await testHelper.selectEventQueueAndReturn(tx, {
        type: "HealthCheck_PERIODIC",
        expectedLength: 2,
        additionalColumns: ["lastAttemptTimestamp"],
      });
      const [open, done] = events.sort((a, b) => a.status - b.status);
      expect(open).toEqual({
        status: EventProcessingStatus.Open,
        attempts: 0,
        startAfter: expect.any(String),
        lastAttemptTimestamp: null,
      });
      expect(done).toEqual({
        status: EventProcessingStatus.Error,
        attempts: 1,
        startAfter: expect.any(String),
        lastAttemptTimestamp: expect.any(String),
      });

      await cds.tx({}, async (tx2) => {
        await tx2.run(
          UPDATE.entity("sap.eventqueue.Event").set({
            startAfter: new Date(),
          })
        );
      });

      jest.spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent").mockResolvedValueOnce();

      await processEventQueue(context, event.type, event.subType);
      expect(lastTs).toEqual(null);
      expect(scheduleNextSpy).toHaveBeenCalledTimes(2);
      expect(loggerMock.callsLengths().error).toEqual(1);
    });
  });

  describe("keep alive", () => {
    let event;
    beforeAll(() => {
      event = eventQueue.config.periodicEvents.find((event) => event.subType === "DBKeepAlive");
    });

    it("straight forward", async () => {
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();

      const { db } = cds.services;
      const { Event } = cds.entities("sap.eventqueue");
      let forUpdateCounter = 0;
      db.before("READ", Event, (req) => {
        if (req.query.SELECT.forUpdate) {
          // 1 counter is select events; 2 keep alive request
          forUpdateCounter++;
        }
      });

      jest.spyOn(EventQueueHealthCheckDb.prototype, "processPeriodicEvent").mockImplementationOnce(async function () {
        await promisify(setTimeout)(2500);
      });

      await processEventQueue(context, event.type, event.subType);

      expect(forUpdateCounter).toBeGreaterThanOrEqual(2);
      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectDone(tx, { type: "HealthCheckKeepAlive_PERIODIC" });
    });

    it("error case", async () => {
      await cds.tx({}, async (tx2) => {
        checkAndInsertPeriodicEventsMock.mockRestore();
        await periodicEventsTest.checkAndInsertPeriodicEvents(tx2.context);
      });
      const scheduleNextSpy = jest
        .spyOn(EventQueueProcessorBase.prototype, "scheduleNextPeriodEvent")
        .mockResolvedValueOnce();

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

      jest.spyOn(EventQueueHealthCheckDb.prototype, "processPeriodicEvent").mockImplementationOnce(async function () {
        await promisify(setTimeout)(2500);
      });

      await processEventQueue(context, event.type, event.subType);

      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error[0][0]).toEqual("keep alive handling failed!");
      expect(forUpdateCounter).toBeGreaterThanOrEqual(2);
      expect(scheduleNextSpy).toHaveBeenCalledTimes(1);
      await testHelper.selectEventQueueAndExpectDone(tx, { type: "HealthCheckKeepAlive_PERIODIC" });
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

const _setCronEventToNow = async (tx, event) => {
  await tx.run(
    UPDATE.entity("sap.eventqueue.Event")
      .set({
        startAfter: new Date().toISOString(),
      })
      .where({ type: event.type })
  );
};
