"use strict";

const cds = require("@sap/cds/lib");
const eventQueue = require("../src");
const path = require("path");
const cdsHelper = require("../src/shared/cdsHelper");
const testHelper = require("./helper");
const { Logger: mockLogger } = require("./mocks/logger");
const { processEventQueue } = require("../src/processEventQueue");

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
    eventQueue.config.isPeriodicEventBlockedCb = null;
    await tx.commit();
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
      const service = await cds.connect.to("NotificationService");
      await service.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      tx = cds.tx({});
      const outboxEvent = await tx.run(SELECT.from("cds.outbox.Messages"));
      expect(outboxEvent).toHaveLength(0);
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 0 });
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("if the service is outboxed cds outbox should be used", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service);
      await outboxedService.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      tx = cds.tx({});
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
        useAsCAPOutbox: true,
      });
    });

    it("if the service is not outboxed no event should be written", async () => {
      const service = await cds.connect.to("NotificationService");
      await service.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      tx = cds.tx({});
      const outboxEvent = await tx.run(SELECT.from("cds.outbox.Messages"));
      expect(outboxEvent).toHaveLength(0);
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 0 });
      expect(loggerMock.calls().info[0][0]).toEqual("sendFiori action triggered");
      expect(loggerMock).sendFioriActionCalled();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("the unboxed version should not use the event-queue", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service);
      await cds.unboxed(outboxedService).send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      tx = cds.tx({});
      const outboxEvent = await tx.run(SELECT.from("cds.outbox.Messages"));
      expect(outboxEvent).toHaveLength(0);
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 0 });
      expect(loggerMock.calls().info[0][0]).toEqual("sendFiori action triggered");
      expect(loggerMock).sendFioriActionCalled();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("if the service is outboxed the event-queue outbox should be used", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service);
      await outboxedService.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      tx = cds.tx({});
      const outboxEvent = await tx.run(SELECT.from("cds.outbox.Messages"));
      expect(outboxEvent).toHaveLength(0);
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
      expect(loggerMock).not.sendFioriActionCalled();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("process outboxed event", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service);
      await outboxedService.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      tx = cds.tx({});
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
      expect(loggerMock).not.sendFioriActionCalled();
      await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
      await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
      expect(loggerMock).sendFioriActionCalled();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("should work for outboxed services by require", async () => {
      const outboxedService = await cds.connect.to("NotificationServiceOutboxedByConfig", {
        impl: "./srv/service/service.js",
        outbox: {
          kind: "persistent-outbox",
        },
      });
      await outboxedService.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      tx = cds.tx({});
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
      expect(loggerMock).not.sendFioriActionCalled();
      await processEventQueue(tx.context, "CAP_OUTBOX", outboxedService.name);
      await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
      expect(loggerMock).sendFioriActionCalled();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("map all available outbox fields", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service);
      await outboxedService.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      tx = cds.tx({});
      const event = await testHelper.selectEventQueueAndReturn(tx, {
        expectedLength: 1,
        additionalColumns: ["payload"],
      });
      const payload = JSON.stringify(event[0].payload);
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
          "user": "anonymous",
        }
      `);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("should store correct user of original context", async () => {
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service);
      tx = cds.tx({});
      tx.context.user = { id: "badman" };
      await outboxedService.tx(tx.context).send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
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
          "user": "badman",
        }
      `);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("map config to event-queue config", async () => {
      eventQueue.config.removeEvent("CAP_OUTBOX", "NotificationService");
      const service = await cds.connect.to("NotificationService");
      const outboxedService = cds.outboxed(service);
      await outboxedService.send("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      tx = cds.tx({});
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
      const config = eventQueue.config.events.find((event) => event.subType === "NotificationService");
      expect(config).toMatchInlineSnapshot(`
        {
          "impl": "./outbox/EventQueueGenericOutboxHandler",
          "internalEvent": true,
          "load": 1,
          "parallelEventProcessing": 5,
          "retryAttempts": 20,
          "selectMaxChunkSize": 100,
          "subType": "NotificationService",
          "type": "CAP_OUTBOX",
        }
      `);
    });
  });
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
