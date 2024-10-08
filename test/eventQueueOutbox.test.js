"use strict";

const cds = require("@sap/cds/lib");
const eventQueue = require("../src");
const path = require("path");
const cdsHelper = require("../src/shared/cdsHelper");
const testHelper = require("./helper");
const { Logger: mockLogger } = require("./mocks/logger");
const { processEventQueue } = require("../src/processEventQueue");
const redisSub = require("../src/redis/redisSub");
const runnerHelper = require("../src/runner/runnerHelper");
const { EventProcessingStatus } = require("../src/constants");
const { checkAndInsertPeriodicEvents } = require("../src/periodicEvents");
const { getOpenQueueEntries } = require("../src/runner/openEvents");

const project = __dirname + "/asset/outboxProject"; // The project's root folder
cds.test(project);

const executeInNewTransactionSpy = jest.spyOn(cdsHelper, "executeInNewTransaction");

describe("event-queue outbox", () => {
  let context, tx, loggerMock;

  beforeAll(() => {
    loggerMock = mockLogger();
  });

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
  beforeEach(async () => {
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
    await tx.run(DELETE.from("sap.eventqueue.Lock"));
    await tx.run(DELETE.from("sap.eventqueue.Event"));
    await tx.run(DELETE.from("cds.outbox.Messages"));
    eventQueue.config.clearPeriodicEventBlockList();
    eventQueue.config.isEventBlockedCb = null;
    await commitAndOpenNew();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await tx.rollback();
    jest.clearAllMocks();
  });

  afterAll(() => cds.shutdown);

  describe("monkeyPatchCAPOutbox=false", () => {
    beforeAll(async () => {
      const configFilePath = path.join(__dirname, "asset", "config.yml");
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
        registerAsEventProcessor: false,
      });
    });

    it("if the service is not outboxed no event should be written", async () => {
      const service = (await cds.connect.to("NotificationService")).tx(tx.context);
      await service.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      const outboxEvent = await tx.run(SELECT.from("cds.outbox.Messages"));
      expect(outboxEvent).toHaveLength(0);
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 0 });
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("if the service is outboxed cds outbox should be used", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service).tx(context);
      await outboxedService.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      const outboxEvent = await tx.run(SELECT.from("cds.outbox.Messages"));
      expect(outboxEvent).toHaveLength(1);
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 0 });
      expect(loggerMock.callsLengths().error).toEqual(0);
    });
  });

  describe("monkeyPatchCAPOutbox=true", () => {
    beforeAll(async () => {
      const configFilePath = path.join(__dirname, "asset", "config.yml");
      eventQueue.config.initialized = false;
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: false,
        registerAsEventProcessor: false,
        insertEventsBeforeCommit: true,
        useAsCAPOutbox: true,
        userId: "dummyTestUser",
      });
      cds.emit("connect", await cds.connect.to("db"));
    });

    it("return open event types", async () => {
      const service = (await cds.connect.to("NotificationService")).tx(context);
      const outboxedService = cds.outboxed(service);
      await outboxedService.send("errorEvent", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await testHelper.insertEventEntry(tx);
      await checkAndInsertPeriodicEvents(context);
      await tx.commit();
      const result = await cds.tx({}, async (tx) => await getOpenQueueEntries(tx));
      expect(result).toMatchSnapshot();
    });

    it("if the service is not outboxed no event should be written", async () => {
      const service = (await cds.connect.to("NotificationService")).tx(tx.context);
      await service.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      const outboxEvent = await tx.run(SELECT.from("cds.outbox.Messages"));
      expect(outboxEvent).toHaveLength(0);
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 0 });
      expect(loggerMock.calls().info[0][0]).toEqual("sendFiori action triggered");
      expect(loggerMock).sendFioriActionCalled();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("the unboxed version should not use the event-queue", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service).tx(context);
      await cds.unboxed(outboxedService).send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      const outboxEvent = await tx.run(SELECT.from("cds.outbox.Messages"));
      expect(outboxEvent).toHaveLength(0);
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 0 });
      expect(loggerMock.calls().info[0][0]).toEqual("sendFiori action triggered");
      expect(loggerMock).sendFioriActionCalled();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("if the service is outboxed the event-queue outbox should be used", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service).tx(context);
      await outboxedService.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      const outboxEvent = await tx.run(SELECT.from("cds.outbox.Messages"));
      expect(outboxEvent).toHaveLength(0);
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
      expect(loggerMock).not.sendFioriActionCalled();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("accept event-queue specific options in headers", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service).tx(context);
      const date = new Date(Date.now() + 4 * 60 * 1000).toISOString();
      await outboxedService.send(
        "sendFiori",
        {
          to: "to",
          subject: "subject",
          body: "body",
        },
        {
          "x-eventqueue-startAfter": date,
          "x-eventqueue-referenceEntity": "sap.eventqueue.Event",
          "x-eventqueue-referenceEntityKey": "6b61308d-e199-41ce-aa9d-a73fc3b218ac",
        }
      );

      await commitAndOpenNew();
      const [event] = await testHelper.selectEventQueueAndReturn(tx, {
        expectedLength: 1,
        additionalColumns: ["payload", "referenceEntity", "referenceEntityKey"],
      });
      expect(event).toMatchObject({
        status: EventProcessingStatus.Open,
        startAfter: date,
        referenceEntity: "sap.eventqueue.Event",
        referenceEntityKey: "6b61308d-e199-41ce-aa9d-a73fc3b218ac",
      });
      const parsedPayload = JSON.parse(event.payload);
      expect(parsedPayload).toMatchSnapshot();
      ["startAfter", "referenceEntity", "referenceEntityKey"].forEach((key) => {
        expect(parsedPayload.headers[`x-eventqueue-${key}`]).toBeUndefined();
        expect(parsedPayload.headers[`x-eventqueue-${key.toLocaleLowerCase()}`]).toBeUndefined();
      });
      await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
      expect(loggerMock).not.sendFioriActionCalled();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("process outboxed event", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service).tx(context);
      await outboxedService.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
      expect(loggerMock).not.sendFioriActionCalled();
      await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
      await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
      expect(loggerMock).sendFioriActionCalled();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("req.data should be stored for sent", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service).tx(context);
      await outboxedService.emit("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      const event = await testHelper.selectEventQueueAndReturn(tx, {
        expectedLength: 1,
        additionalColumns: ["payload"],
      });
      const payload = JSON.parse(event[0].payload);
      expect(loggerMock).not.sendFioriActionCalled();
      expect(payload).toMatchSnapshot();
      await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
      expect(loggerMock.calls().info.find((log) => log[0].includes("sendFiori action triggered"))[1])
        .toMatchInlineSnapshot(`
        {
          "data": {
            "body": "body",
            "subject": "subject",
            "to": "to",
          },
          "eventQueueId": "NotificationService",
          "user": "testUser",
        }
      `);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("req.data should be stored for emit", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service).tx(context);
      await outboxedService.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      const event = await testHelper.selectEventQueueAndReturn(tx, {
        expectedLength: 1,
        additionalColumns: ["payload"],
      });
      const payload = JSON.parse(event[0].payload);
      expect(loggerMock).not.sendFioriActionCalled();
      expect(payload).toMatchSnapshot();
      await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
      expect(loggerMock.calls().info.find((log) => log[0].includes("sendFiori action triggered"))[1])
        .toMatchInlineSnapshot(`
        {
          "data": {
            "body": "body",
            "subject": "subject",
            "to": "to",
          },
          "eventQueueId": "NotificationService",
          "user": "testUser",
        }
      `);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("should store correct user of original context", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service).tx(context);
      tx.context.user = { id: "badman" };
      await outboxedService.tx(tx.context).send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      const event = await testHelper.selectEventQueueAndReturn(tx, {
        expectedLength: 1,
        additionalColumns: ["payload"],
      });
      const payload = JSON.parse(event[0].payload);
      expect(loggerMock).not.sendFioriActionCalled();
      expect(payload).toMatchSnapshot();
      await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
      expect(loggerMock.calls().info.find((log) => log[0].includes("sendFiori action triggered"))[1])
        .toMatchInlineSnapshot(`
        {
          "data": {
            "body": "body",
            "subject": "subject",
            "to": "to",
          },
          "eventQueueId": "NotificationService",
          "user": "badman",
        }
      `);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("map config to event-queue config", async () => {
      eventQueue.config.removeEvent("CAP_OUTBOX", "NotificationService");
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service).tx(context);
      await outboxedService.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
      const config = eventQueue.config.events.find((event) => event.subType === "NotificationService");
      expect(config).toMatchInlineSnapshot(`
        {
          "_appInstancesMap": null,
          "_appNameMap": null,
          "appInstances": undefined,
          "appNames": undefined,
          "checkForNextChunk": undefined,
          "deleteFinishedEventsAfterDays": undefined,
          "eventOutdatedCheck": undefined,
          "impl": "./outbox/EventQueueGenericOutboxHandler",
          "internalEvent": true,
          "load": 1,
          "parallelEventProcessing": 5,
          "processAfterCommit": undefined,
          "retryAttempts": 20,
          "selectMaxChunkSize": 100,
          "subType": "NotificationService",
          "transactionMode": undefined,
          "type": "CAP_OUTBOX",
          "useEventQueueUser": undefined,
        }
      `);
    });

    it("should work for outboxed services by require with transactionMode config", async () => {
      const outboxedService = await cds.connect.to("NotificationServiceOutboxedByConfig", {
        impl: "./srv/service/service.js",
        outbox: {
          kind: "persistent-outbox",
          transactionMode: "alwaysRollback",
        },
      });
      await outboxedService.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
      expect(loggerMock).not.sendFioriActionCalled();
      await processEventQueue(tx.context, "CAP_OUTBOX", outboxedService.name);
      await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
      expect(loggerMock).sendFioriActionCalled();
      const config = eventQueue.config.events.find((event) => event.subType === "NotificationServiceOutboxedByConfig");
      delete config.startTime;
      expect(config).toMatchInlineSnapshot(`
        {
          "_appInstancesMap": null,
          "_appNameMap": null,
          "appInstances": undefined,
          "appNames": undefined,
          "checkForNextChunk": undefined,
          "deleteFinishedEventsAfterDays": undefined,
          "eventOutdatedCheck": undefined,
          "impl": "./outbox/EventQueueGenericOutboxHandler",
          "internalEvent": true,
          "load": 1,
          "parallelEventProcessing": 5,
          "processAfterCommit": undefined,
          "retryAttempts": 20,
          "selectMaxChunkSize": 100,
          "subType": "NotificationServiceOutboxedByConfig",
          "transactionMode": "alwaysRollback",
          "type": "CAP_OUTBOX",
          "useEventQueueUser": undefined,
        }
      `);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("should catch errors and log them", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service).tx(context);
      await outboxedService.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });

      const mock = () => {
        jest.spyOn(cds, "log").mockImplementationOnce((...args) => {
          if (args[0] === "sendFiori") {
            throw new Error("service error - sendFiori");
          }
          const instance = cds.log(...args);
          mock();
          return instance;
        });
      };
      mock();
      await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
      await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchInlineSnapshot(`
        [
          [
            "error processing outboxed service call",
            [Error: service error - sendFiori],
            {
              "serviceName": "NotificationService",
            },
          ],
        ]
      `);
    });

    it("init event-queue without yml", async () => {
      eventQueue.config.initialized = false;
      await eventQueue.initialize({
        processEventsAfterPublish: false,
        registerAsEventProcessor: false,
        useAsCAPOutbox: true,
        userId: "dummyTestUser",
      });

      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service).tx(context);
      await outboxedService.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
      expect(loggerMock).not.sendFioriActionCalled();
      await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
      await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
      expect(loggerMock).sendFioriActionCalled();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("req reject should be caught for send", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service).tx(context);
      await outboxedService.send("rejectEvent", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });

      await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
      await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
    });

    it("req reject should cause an error for emit", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service).tx(context);
      await outboxedService.emit("rejectEvent", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });

      await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
      await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
    });

    it("req error should be caught for send", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service).tx(context);
      await outboxedService.send("errorEvent", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });

      await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
      await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
    });

    it("req error should be caught for emit", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service).tx(context);
      await outboxedService.emit("errorEvent", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });

      await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
      await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
    });

    describe("not connected service should lazily connect and create configuration", () => {
      beforeEach(() => {
        eventQueue.config.removeEvent("CAP_OUTBOX", "NotificationService");
      });

      it("redisSub", async () => {
        const type = "CAP_OUTBOX";
        const subType = "NotificationServiceLazyInitTest";
        let config = eventQueue.config.getEventConfig(type, subType);
        expect(config).toBeUndefined();
        const runEventCombinationForTenantSpy = jest
          .spyOn(runnerHelper, "runEventCombinationForTenant")
          .mockResolvedValueOnce();
        await redisSub.__._messageHandlerProcessEvents(
          JSON.stringify({
            type,
            subType,
          })
        );
        config = eventQueue.config.getEventConfig(type, subType);
        expect(config).toBeDefined();
        expect(loggerMock.callsLengths().error).toEqual(0);
        expect(runEventCombinationForTenantSpy).toHaveBeenCalledTimes(1);
      });

      it("should log an error for not CAP outboxed services", async () => {
        const type = "NOT_CAP_OUTBOX";
        const subType = "NotificationServiceLaizyInitTest";
        let config = eventQueue.config.getEventConfig(type, subType);
        expect(config).toBeUndefined();
        const runEventCombinationForTenantSpy = jest.spyOn(runnerHelper, "runEventCombinationForTenant");
        await redisSub.__._messageHandlerProcessEvents(
          JSON.stringify({
            type,
            subType,
          })
        );
        config = eventQueue.config.getEventConfig(type, subType);
        expect(config).toBeUndefined();
        expect(loggerMock.callsLengths().error).toEqual(1);
        expect(runEventCombinationForTenantSpy).toHaveBeenCalledTimes(0);
      });
    });

    it("option to use eventQueue.userId in outboxed services", async () => {
      const outboxedService = await cds.connect.to("NotificationServiceOutboxedByConfigUserId", {
        impl: "./srv/service/service.js",
        outbox: {
          kind: "persistent-outbox",
          transactionMode: "alwaysRollback",
          useEventQueueUser: true,
        },
      });
      await outboxedService.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });

      await processEventQueue(tx.context, "CAP_OUTBOX", outboxedService.name);
      expect(loggerMock.calls().info.find((log) => log[0].includes("sendFiori action triggered"))[1])
        .toMatchInlineSnapshot(`
        {
          "data": {
            "body": "body",
            "subject": "subject",
            "to": "to",
          },
          "eventQueueId": "NotificationServiceOutboxedByConfigUserId",
          "user": "dummyTestUser",
        }
      `);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });
  });

  const commitAndOpenNew = async () => {
    await tx.commit();
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
  };
});

expect.extend({
  sendFioriActionCalled: (lockerMock) => {
    return {
      message: () => "sendFiori Action not called",
      pass: lockerMock
        .calls()
        .info.map((call) => call[0])
        .includes("sendFiori action triggered"),
    };
  },
});
