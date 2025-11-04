"use strict";

const { promisify } = require("util");
const otel = require("@opentelemetry/api");
jest.mock("@opentelemetry/api", () => require("./mocks/openTelemetry"));
const { Logger: mockLogger } = require("./mocks/logger");
const loggerMock = mockLogger();

const cds = require("@sap/cds");
const eventQueue = require("../src");
const path = require("path");
const testHelper = require("./helper");
const { processEventQueue } = require("../src/processEventQueue");
const redisSub = require("../src/redis/redisSub");
const runnerHelper = require("../src/runner/runnerHelper");
const { EventProcessingStatus } = require("../src/constants");
const { checkAndInsertPeriodicEvents } = require("../src/periodicEvents");
const { getOpenQueueEntries } = require("../src/runner/openEvents");
const EventQueueGenericOutboxHandler = require("../src/outbox/EventQueueGenericOutboxHandler");
const { getEnvInstance } = require("../src/shared/env");
const { CronExpressionParser } = require("cron-parser");
const common = require("../src/shared/common");
const config = require("../src/config");

const CUSTOM_HOOKS_SRV = "OutboxCustomHooks";
const basePath = path.join(__dirname, "asset", "outboxProject");

cds.env.requires.NotificationServicePeriodic = {
  impl: path.join(basePath, "srv/service/servicePeriodic.js"),
  outbox: {
    kind: "persistent-outbox",
    load: 60,
    checkForNextChunk: true,
    transactionMode: "isolated",
    events: {
      main: {
        cron: "*/15 * * * * *",
      },
      action: {
        checkForNextChunk: false,
      },
      randomOffset: {
        cron: "*/15 * * * * *",
        randomOffset: 60,
      },
    },
  },
};

cds.env.requires.OutboxCustomHooks = {
  impl: path.join(basePath, "srv/service/serviceCustomHooks.js"),
  outbox: {
    kind: "persistent-outbox",
    checkForNextChunk: false,
    events: {
      exceededAction: {
        retryAttempts: 1,
        retryFailedAfter: 0,
      },
      connectSpecific: {
        retryAttempts: 1,
        retryFailedAfter: 0,
      },
      exceededActionSpecific: {
        retryAttempts: 1,
        retryFailedAfter: 0,
      },
    },
  },
};

cds.env.requires.AppNames = {
  impl: path.join(basePath, "srv/service/serviceAppNames.js"),
  outbox: {
    kind: "persistent-outbox",
    checkForNextChunk: false,
    events: {
      appNamesString: {
        appNames: ["srv-backend"],
      },
      appNamesRegex: {
        appNames: ["/^srv-backend.*/i"],
      },
      appNamesMixStringMatch: {
        appNames: ["/^srv-backend.*/i", "a-srv-backend"],
      },
      appNamesMixRegexMatch: {
        appNames: ["/^a-srv-backend.*/i", "srv-backend"],
      },
      appNamesReverseMixRegexMatch: {
        appNames: ["a-srv-backend", "/^srv-backend.*/i"],
      },
    },
  },
};

cds.env.requires.StandardService = {
  impl: path.join(basePath, "srv/service/standard-service.js"),
  outbox: {
    kind: "persistent-outbox",
    events: {
      timeBucketAction: {
        timeBucket: "*/60 * * * * *",
      },
    },
  },
};

cds.env.requires.QueueService = {
  impl: path.join(basePath, "srv/service/standard-service.js"),
  queued: {
    kind: "persistent-queue",
    events: {
      timeBucketAction: {
        timeBucket: "*/60 * * * * *",
      },
      main: {
        cron: "*/15 * * * * *",
      },
    },
  },
};

cds.env.requires.Namespace = {
  impl: path.join(basePath, "srv/service/standard-service.js"),
  outbox: {
    kind: "persistent-outbox",
    namespace: "namespaceA",
    events: {
      timeBucketAction: {
        timeBucket: "*/60 * * * * *",
      },
    },
  },
};

const project = __dirname + "/asset/outboxProject"; // The project's root folder
cds.test(project);

describe("event-queue outbox", () => {
  let context, tx;

  beforeEach(async () => {
    eventQueue.config.enableTelemetry = true;
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
      eventQueue.config.initialized = false;
      await eventQueue.initialize({
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
      await commitAndOpenNew();
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
      await commitAndOpenNew();
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
      expect(loggerMock.calls().info.find((log) => log[0].includes("sendFiori action triggered"))[1]).toMatchSnapshot();
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
      expect(loggerMock.calls().info.find((log) => log[0].includes("sendFiori action triggered"))[1]).toMatchSnapshot();
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
      expect(loggerMock.calls().info.find((log) => log[0].includes("sendFiori action triggered"))[1]).toMatchSnapshot();
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
      expect(config).toMatchSnapshot();
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
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
      expect(loggerMock).sendFioriActionCalled();
      const config = eventQueue.config.events.find((event) => event.subType === "NotificationServiceOutboxedByConfig");
      delete config.startTime;
      expect(config).toMatchSnapshot();
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
      await commitAndOpenNew();
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
        isEventQueueActive: true,
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
      await commitAndOpenNew();
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
      await commitAndOpenNew();
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
      await commitAndOpenNew();
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
      await commitAndOpenNew();
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
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
    });

    it("error in srv.after", async () => {
      const service = await cds.connect.to("NotificationService");
      service.after("sendFiori", async () => {
        await SELECT.one.from("sap.eventqueue.Event");
        throw new Error("sendFiori error");
      });
      const outboxedService = cds.outboxed(service).tx(context);
      await outboxedService.emit("sendFiori", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });

      await commitAndOpenNew();
      await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
      service.handlers.after = [];
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
    });

    it("custom options should win over service options", async () => {
      const service = await cds.connect.to("NotificationServiceOutboxedByConfig", {
        impl: "./srv/service/service.js",
        outbox: {
          kind: "persistent-outbox",
          transactionMode: "alwaysRollback",
        },
      });
      const outboxedService = cds.outboxed(service, {
        kind: "persistent-outbox",
        transactionMode: "alwaysCommit",
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
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
      expect(loggerMock).sendFioriActionCalled();
      const config = eventQueue.config.events.find((event) => event.subType === "NotificationServiceOutboxedByConfig");
      delete config.startTime;
      expect(config).toMatchSnapshot();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("should use timeBucket config", async () => {
      const service = (await cds.connect.to("StandardService")).tx(context);
      await service.send("timeBucketAction", {
        to: "to",
        subject: "subject",
        body: "body",
      });
      await commitAndOpenNew();
      const [event] = await testHelper.selectEventQueueAndReturn(tx, {
        expectedLength: 1,
        additionalColumns: ["subType", "createdAt"],
      });
      const pattern = cds.env.requires.StandardService.outbox.events.timeBucketAction.timeBucket;
      const expectedDate = CronExpressionParser.parse(pattern, {
        currentDate: new Date(event.createdAt),
      })
        .next()
        .toISOString();
      expect(event.startAfter).toBeDefined();
      expect(expectedDate).toEqual(event.startAfter);
      expect(event.subType).toEqual("StandardService.timeBucketAction");
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("check that authInfo is correctly exposed on the user", async () => {
      jest.spyOn(common, "getAuthContext").mockResolvedValue({ authInfo: 123 });
      const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
      const data = { to: "to", subject: "subject", body: "body" };
      await service.send("authInfo", data);
      await commitAndOpenNew();
      await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
      await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
      await commitAndOpenNew();
      expect(loggerMock).actionCalled("authInfo", { authInfo: { authInfo: 123 } });
      await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
      expect(loggerMock.callsLengths().error).toEqual(0);
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
        expect(loggerMock.callsLengths().warn).toEqual(1);
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
      expect(loggerMock.calls().info.find((log) => log[0].includes("sendFiori action triggered"))[1]).toMatchSnapshot();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    describe("allow to return status", () => {
      it("simple status value to done", async () => {
        const service = await cds.connect.to("NotificationService");
        const outboxedService = cds.outboxed(service).tx(context);
        await outboxedService.send("returnPlainStatus", {
          status: EventProcessingStatus.Done,
        });
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("simple status value to error", async () => {
        const service = await cds.connect.to("NotificationService");
        const outboxedService = cds.outboxed(service).tx(context);
        await outboxedService.send("returnPlainStatus", {
          status: EventProcessingStatus.Error,
        });
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("return status with array syntax to done", async () => {
        const service = await cds.connect.to("NotificationService");
        const outboxedService = cds.outboxed(service).tx(context);
        await outboxedService.send("returnStatusAsArray", {
          status: EventProcessingStatus.Done,
        });
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("return status with array syntax to error", async () => {
        const service = await cds.connect.to("NotificationService");
        const outboxedService = cds.outboxed(service).tx(context);
        await outboxedService.send("returnStatusAsArray", {
          status: EventProcessingStatus.Error,
        });
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("not valid status should be ignored", async () => {
        const service = await cds.connect.to("NotificationService");
        const outboxedService = cds.outboxed(service).tx(context);
        await outboxedService.send("returnStatusAsArray", {
          status: "K",
        });
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
        expect(loggerMock.callsLengths().error).toEqual(0);
      });
    });

    describe("trace context", () => {
      it("should extract current trace context and save", async () => {
        jest.spyOn(otel.propagation, "inject").mockImplementationOnce((context, carrier) => {
          carrier.traceparent = "00-ac46cd732064b44a9c692c2062db8fbd-5fa4a29b5675b3c3-01";
        });
        const service = await cds.connect.to("NotificationService");
        const outboxedService = cds.outboxed(service).tx(context);
        await outboxedService.send("sendFiori", {
          to: "to",
          subject: "subject",
          body: "body",
        });
        await commitAndOpenNew();
        const [event] = await testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 1,
          additionalColumns: ["context"],
        });
        expect(JSON.parse(event.context)).toMatchSnapshot();
        expect(loggerMock).not.sendFioriActionCalled();
      });

      it("should use stored trace context in next processing", async () => {
        jest.spyOn(otel.propagation, "inject").mockImplementationOnce((context, carrier) => {
          carrier.traceparent = "00-ac46cd732064b44a9c692c2062db8fbd-5fa4a29b5675b3c3-01";
        });
        const service = await cds.connect.to("NotificationService");
        const outboxedService = cds.outboxed(service).tx(context);
        await outboxedService.send("sendFiori", {
          to: "to",
          subject: "subject",
          body: "body",
        });
        await commitAndOpenNew();
        const [event] = await testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 1,
          additionalColumns: ["context"],
        });
        expect(JSON.parse(event.context)).toMatchSnapshot();
        expect(loggerMock).not.sendFioriActionCalled();
        await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
        expect(loggerMock).sendFioriActionCalled();
        expect(loggerMock.callsLengths().error).toEqual(0);
        expect(jest.spyOn(otel.propagation, "extract")).toHaveBeenCalledWith("mocked-context", {
          traceparent: "00-ac46cd732064b44a9c692c2062db8fbd-5fa4a29b5675b3c3-01",
        });
      });

      it("should not use stored trace context if disabled by config", async () => {
        jest.spyOn(otel.propagation, "inject").mockImplementationOnce((context, carrier) => {
          carrier.traceparent = "00-ac46cd732064b44a9c692c2062db8fbd-5fa4a29b5675b3c3-01";
        });
        const service = await cds.connect.to("NotificationService");
        const outboxedService = cds.outboxed(service).tx(context);
        await outboxedService.send("sendFiori", {
          to: "to",
          subject: "subject",
          body: "body",
        });
        await commitAndOpenNew();
        const [event] = await testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 1,
          additionalColumns: ["context"],
        });
        expect(JSON.parse(event.context)).toMatchSnapshot();
        expect(loggerMock).not.sendFioriActionCalled();
        eventQueue.config.events.find(({ subType }) => subType === "NotificationService").inheritTraceContext = false;

        await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
        expect(loggerMock).sendFioriActionCalled();
        expect(loggerMock.callsLengths().error).toEqual(0);
        expect(jest.spyOn(otel.propagation, "extract")).toHaveBeenCalledTimes(0);
      });
    });

    describe("ad-hoc events overwrite settings via outbox.events", () => {
      it("specific ad-hoc event should create own config", async () => {
        const service = (await cds.connect.to("NotificationServicePeriodic")).tx(context);
        const getQueueEntries = jest.spyOn(
          EventQueueGenericOutboxHandler.prototype,
          "getQueueEntriesAndSetToInProgress"
        );
        await service.send("action", {});
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        await processEventQueue(tx.context, "CAP_OUTBOX", [service.name, "action"].join("."));
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
        expect(eventQueue.config.events.find(({ subType }) => subType.includes("action"))).toMatchSnapshot();
        expect(getQueueEntries).toHaveBeenCalledTimes(1);
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("should create specific config during select", async () => {
        const service = (await cds.connect.to("NotificationServicePeriodic")).tx(context);
        await service.send("action", {});
        await commitAndOpenNew();
        delete eventQueue.config._rawEventMap["CAP_OUTBOX##NotificationServicePeriodic.action"];

        // NOTE: after deleting the config make sure config is not available
        await processEventQueue(tx.context, "CAP_OUTBOX", [service.name, "action"].join("."));
        expect(eventQueue.config.events.find(({ subType }) => subType.includes("action"))).toBeUndefined();
        expect(loggerMock.calls().error[0]).toMatchSnapshot();

        const openEvents = await getOpenQueueEntries(tx);
        await promisify(setTimeout)(1);

        expect(openEvents).toHaveLength(1);
        expect(eventQueue.config.events.find(({ subType }) => subType.includes("action"))).toBeDefined();
      });

      it("unchanged parameter from the generic config should remain the same for the specific event", async () => {
        const service = (await cds.connect.to("NotificationServicePeriodic")).tx(context);
        const getQueueEntries = jest.spyOn(
          EventQueueGenericOutboxHandler.prototype,
          "getQueueEntriesAndSetToInProgress"
        );
        await service.send("action", {});
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        await processEventQueue(tx.context, "CAP_OUTBOX", [service.name, "action"].join("."));
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
        const specificEventConfig = eventQueue.config.events.find(({ subType }) => subType.includes("action"));
        const genericEventConfig = eventQueue.config.events.find(
          ({ subType }) => subType === "NotificationServicePeriodic"
        );
        expect(specificEventConfig).toMatchSnapshot();
        // NOTE: remove the expected changes to check that all other settings are still the same
        ["checkForNextChunk", "subType"].forEach((element) => {
          delete specificEventConfig[element];
          delete genericEventConfig[element];
        });
        expect(specificEventConfig).toEqual(genericEventConfig);
        expect(getQueueEntries).toHaveBeenCalledTimes(1);
        expect(loggerMock.callsLengths().error).toEqual(0);
      });
    });

    describe("periodic events", () => {
      it("insert periodic event for CAP service", async () => {
        await checkAndInsertPeriodicEvents(context);
        const [periodicEvent] = await testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 3,
          additionalColumns: ["type", "subType"],
        });
        expect(periodicEvent.startAfter).toBeDefined();
        delete periodicEvent.startAfter;
        expect(periodicEvent).toMatchSnapshot();
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("insert periodic event for CAP service and process", async () => {
        const subType = "NotificationServicePeriodic.main";
        await checkAndInsertPeriodicEvents(context);
        const [periodicEvent] = await testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 1,
          additionalColumns: ["type", "subType"],
          subType,
        });
        await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ startAfter: null }));

        await eventQueue.processEventQueue(context, periodicEvent.type, periodicEvent.subType);
        const [openEvent, processedEvent] = await testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 2,
          additionalColumns: ["type", "subType", "createdAt"],
          subType,
        });
        expect(openEvent).toMatchObject({
          status: 0,
          attempts: 0,
          type: "CAP_OUTBOX_PERIODIC",
          subType,
          startAfter: CronExpressionParser.parse("*/15 * * * * *", {
            currentDate: new Date(processedEvent.createdAt),
          })
            .next()
            .toISOString(),
        });
        expect(processedEvent).toMatchObject({
          status: 2,
          attempts: 1,
          type: "CAP_OUTBOX_PERIODIC",
          subType,
          startAfter: null,
        });
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("insert periodic event for CAP service with random offset", async () => {
        const subType = "NotificationServicePeriodic.randomOffset";
        await checkAndInsertPeriodicEvents(context);
        const [periodicEvent] = await testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 1,
          additionalColumns: ["type", "subType"],
          subType,
        });
        await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ startAfter: null }));

        await eventQueue.processEventQueue(context, periodicEvent.type, periodicEvent.subType);
        const [openEvent, processedEvent] = await testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 2,
          additionalColumns: ["type", "subType", "createdAt"],
          subType,
        });
        const withoutOffset = CronExpressionParser.parse("*/15 * * * * *", {
          currentDate: new Date(processedEvent.createdAt),
        }).next();
        const calculatedOffset = new Date(openEvent.startAfter).getTime() - withoutOffset.getTime();
        // NOTE: defined offset for event is 60 seconds
        expect(calculatedOffset).toBeLessThanOrEqual(60 * 1000);
        expect(openEvent).toMatchObject({
          status: 0,
          attempts: 0,
          type: "CAP_OUTBOX_PERIODIC",
          subType,
        });
        expect(processedEvent).toMatchObject({
          status: 2,
          attempts: 1,
          type: "CAP_OUTBOX_PERIODIC",
          subType,
          startAfter: null,
        });
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("insert periodic event for CAP service with global random offset", async () => {
        const subType = "NotificationServicePeriodic.main";
        config.randomOffsetPeriodicEvents = 15;
        await checkAndInsertPeriodicEvents(context);
        const [periodicEvent] = await testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 1,
          additionalColumns: ["type", "subType"],
          subType,
        });
        await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ startAfter: null }));

        await eventQueue.processEventQueue(context, periodicEvent.type, periodicEvent.subType);
        const [openEvent, processedEvent] = await testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 2,
          additionalColumns: ["type", "subType", "createdAt"],
          subType,
        });
        const withoutOffset = CronExpressionParser.parse("*/15 * * * * *", {
          currentDate: new Date(processedEvent.createdAt),
        }).next();
        const calculatedOffset = new Date(openEvent.startAfter).getTime() - withoutOffset.getTime();
        // NOTE: defined offset for event is 15 seconds
        expect(calculatedOffset).toBeLessThanOrEqual(15 * 1000);
        expect(openEvent).toMatchObject({
          status: 0,
          attempts: 0,
          type: "CAP_OUTBOX_PERIODIC",
          subType,
        });
        expect(processedEvent).toMatchObject({
          status: 2,
          attempts: 1,
          type: "CAP_OUTBOX_PERIODIC",
          subType,
          startAfter: null,
        });
        expect(loggerMock.callsLengths().error).toEqual(0);
        config.randomOffsetPeriodicEvents = null;
      });

      describe("inherit config", () => {
        it("simple push down", async () => {
          const [periodicEvent] = eventQueue.config.periodicEvents;
          expect(periodicEvent).toMatchSnapshot();
        });

        it("overwrite in specific section", async () => {
          cds.env.requires.NotificationServicePeriodic.outbox.events.main.transactionMode = "alwaysRollback";
          eventQueue.config.mixFileContentWithEnv({});
          const [periodicEvent] = eventQueue.config.periodicEvents;
          expect(periodicEvent).toMatchSnapshot();
          delete cds.env.requires.NotificationServicePeriodic.outbox.events.main.transactionMode;
        });

        it("cron/interval on top level is not allowed", async () => {
          cds.env.requires.NotificationServicePeriodic.outbox.interval = 20;
          eventQueue.config.mixFileContentWithEnv({});
          const [periodicEvent] = eventQueue.config.periodicEvents;
          expect(periodicEvent).toMatchSnapshot();
          expect(loggerMock.calls().error[0]).toMatchSnapshot();
        });
      });
    });

    describe("custom hooks", () => {
      describe("eventQueueCheckAndAdjustPayload", () => {
        it("specific action call", async () => {
          const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
          const data = { to: "to", subject: "subject", body: "body" };
          const modifiedData = { ...data, to: "newValue" };
          await service.send("action", data);
          await commitAndOpenNew();
          await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await commitAndOpenNew();
          expect(loggerMock).actionCalled("eventQueueCheckAndAdjustPayload.action", { data: modifiedData });
          expect(loggerMock).actionCalled("action", { data: modifiedData });
          await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
          expect(loggerMock.callsLengths().error).toEqual(0);
        });

        it("non specific action call", async () => {
          const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
          const data = { to: "to", subject: "subject", body: "body" };
          await service.send("main", data);
          await commitAndOpenNew();
          await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await commitAndOpenNew();
          expect(loggerMock).actionCalled("eventQueueCheckAndAdjustPayload", { data });
          expect(loggerMock).actionCalled("main", { data });
          await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
          expect(loggerMock.callsLengths().error).toEqual(0);
        });

        it("mixed both should be called", async () => {
          const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
          const data = { to: "to", subject: "subject", body: "body" };
          const dataSpecific = { to: "toSpecific", subject: "subject", body: "body" };
          const modifiedData = { ...data, to: "newValue" };
          await service.send("main", data);
          await service.send("action", dataSpecific);
          await commitAndOpenNew();
          await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 2 });
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await commitAndOpenNew();
          expect(loggerMock).actionCalled("eventQueueCheckAndAdjustPayload", { data });
          expect(loggerMock).actionCalled("eventQueueCheckAndAdjustPayload.action", { data: modifiedData });
          expect(loggerMock).actionCalled("main", { data });
          expect(loggerMock).actionCalled("action", { data: modifiedData });
          await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
          expect(loggerMock.callsLengths().error).toEqual(0);
        });
      });

      describe("eventQueueCluster", () => {
        it("non specific action call", async () => {
          const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
          const data = { to: "to", subject: "subject", body: "body" };
          await service.send("main", data);
          await commitAndOpenNew();
          const [eventEntry] = await testHelper.selectEventQueueAndReturn(tx, {
            expectedLength: 1,
            additionalColumns: "*",
            parseColumns: true,
          });
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await commitAndOpenNew();
          eventEntry.lastAttemptTimestamp = expect.any(String);
          expect(loggerMock).actionCalled("eventQueueCluster");
          expect(loggerMock).actionCalled("main", { data: eventEntry.payload.data });
          await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
          expect(loggerMock.callsLengths().error).toEqual(0);
        });

        describe("specific action calls", () => {
          it("actionClusterByPayloadWithCb", async () => {
            const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
            const data = { to: "me", guids: [cds.utils.uuid()], subject: "subject", body: "body" };
            const data2 = { to: "me", guids: [cds.utils.uuid()], subject: "subject", body: "body" };
            await service.send("actionClusterByPayloadWithCb", data);
            await service.send("actionClusterByPayloadWithCb", data2);
            await commitAndOpenNew();
            await testHelper.selectEventQueueAndExpectOpen(tx, {
              expectedLength: 2,
            });
            await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
            await commitAndOpenNew();
            expect(loggerMock).actionCalledTimes("eventQueueCluster.actionClusterByPayloadWithCb", 1);
            expect(loggerMock).actionCalledTimes("actionClusterByPayloadWithCb", 1);
            expect(loggerMock).actionCalled("actionClusterByPayloadWithCb", {
              data: { ...data, guids: expect.arrayContaining(data.guids.concat(data2.guids)) },
            });
            await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
            expect(loggerMock.callsLengths().error).toEqual(0);
          });

          it("should use correct cluster key", async () => {
            const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
            const data = { to: "me", guids: [cds.utils.uuid()], subject: "subject", body: "body" };
            const data2 = { to: "me", guids: [cds.utils.uuid()], subject: "subject", body: "body" };
            await service.send("actionClusterByPayloadWithCb", data);
            await service.send("actionClusterByPayloadWithCb", data2);
            await commitAndOpenNew();
            await testHelper.selectEventQueueAndExpectOpen(tx, {
              expectedLength: 2,
            });
            await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
            await commitAndOpenNew();
            expect(loggerMock).actionCalledTimes("eventQueueCluster.actionClusterByPayloadWithCb", 1);
            expect(loggerMock).actionCalledTimes("actionClusterByPayloadWithCb", 1);
            expect(loggerMock).actionCalled("actionClusterByPayloadWithCb", {
              data: { ...data, guids: expect.arrayContaining(data.guids.concat(data2.guids)) },
            });
            expect(loggerMock).actionCalled("clusterKey", {
              clusterKey: data.to,
            });
            await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
            expect(loggerMock.callsLengths().error).toEqual(0);
          });

          it("actionClusterByPayloadWithoutCb", async () => {
            const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
            const data = { to: "me", guids: [cds.utils.uuid()], subject: "subject", body: "body" };
            const data2 = { to: "me", guids: data.guids, subject: "subject", body: "body" };
            await service.send("actionClusterByPayloadWithoutCb", data);
            await service.send("actionClusterByPayloadWithoutCb", data2);
            await commitAndOpenNew();
            await testHelper.selectEventQueueAndExpectOpen(tx, {
              expectedLength: 2,
            });
            await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
            await commitAndOpenNew();
            expect(loggerMock).actionCalledTimes("eventQueueCluster.actionClusterByPayloadWithoutCb", 1);
            expect(loggerMock).actionCalledTimes("actionClusterByPayloadWithoutCb", 1);
            expect(loggerMock).actionCalled("actionClusterByPayloadWithoutCb", {
              data,
            });
            await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
            expect(loggerMock.callsLengths().error).toEqual(0);
          });

          it("actionClusterByEventWithCb", async () => {
            const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
            const data = { to: "me", guids: [cds.utils.uuid()], subject: "subject", body: "body" };
            const data2 = { to: "me", guids: [cds.utils.uuid()], subject: "subject", body: "body" };
            await service.send("actionClusterByEventWithCb", data, {
              "x-eventqueue-referenceEntityKey": data.guids[0],
            });
            await service.send("actionClusterByEventWithCb", data2, {
              "x-eventqueue-referenceEntityKey": data.guids[0],
            });
            await commitAndOpenNew();
            await testHelper.selectEventQueueAndExpectOpen(tx, {
              expectedLength: 2,
            });
            await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
            await commitAndOpenNew();
            expect(loggerMock).actionCalledTimes("eventQueueCluster.actionClusterByEventWithCb", 1);
            expect(loggerMock).actionCalledTimes("actionClusterByEventWithCb", 1);
            expect(loggerMock).actionCalled("actionClusterByEventWithCb", {
              data: { ...data, guids: expect.arrayContaining(data.guids.concat(data2.guids)) },
            });
            await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
            expect(loggerMock.callsLengths().error).toEqual(0);
          });

          it("actionClusterByEventWithoutCb", async () => {
            const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
            const data = { to: "me", guids: [cds.utils.uuid()], subject: "subject", body: "body" };
            const data2 = { to: "me", guids: data.guids, subject: "subject", body: "body" };
            await service.send("actionClusterByEventWithoutCb", data, {
              "x-eventqueue-referenceEntityKey": data.guids[0],
            });
            await service.send("actionClusterByEventWithoutCb", data2, {
              "x-eventqueue-referenceEntityKey": data.guids[0],
            });
            await commitAndOpenNew();
            await testHelper.selectEventQueueAndExpectOpen(tx, {
              expectedLength: 2,
            });
            await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
            await commitAndOpenNew();
            expect(loggerMock).actionCalledTimes("eventQueueCluster.actionClusterByEventWithoutCb", 1);
            expect(loggerMock).actionCalledTimes("actionClusterByEventWithoutCb", 1);
            expect(loggerMock).actionCalled("actionClusterByEventWithoutCb", {
              data,
            });
            await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
            expect(loggerMock.callsLengths().error).toEqual(0);
          });

          it("actionClusterByDataWithCb", async () => {
            const srv = await cds.connect.to(CUSTOM_HOOKS_SRV);
            const service = srv.tx(context);
            const data = { to: "me", subject: "subject", body: "body" };

            await service.send("actionClusterByDataWithCb", data);
            await service.send("actionClusterByDataWithCb", data);
            await commitAndOpenNew();
            await testHelper.selectEventQueueAndExpectOpen(tx, {
              expectedLength: 2,
            });
            await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
            await commitAndOpenNew();
            expect(loggerMock).actionCalledTimes("actionClusterByDataWithCb", 1);
            await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
            expect(loggerMock.callsLengths().error).toEqual(0);
          });

          it("should cluster two based on a data property", async () => {
            const srv = await cds.connect.to(CUSTOM_HOOKS_SRV);
            const service = srv.tx(context);
            const data = { to: "me", subject: "subject", body: "body" };

            await service.send("actionClusterByData", data);
            await service.send("actionClusterByData", data);
            await commitAndOpenNew();
            await testHelper.selectEventQueueAndExpectOpen(tx, {
              expectedLength: 2,
            });
            await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
            await commitAndOpenNew();
            expect(loggerMock).actionCalledTimes("actionClusterByData", 1);
            await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
            expect(loggerMock.callsLengths().error).toEqual(0);
          });

          it("should cluster two based on the action/event name", async () => {
            const srv = await cds.connect.to(CUSTOM_HOOKS_SRV);
            const service = srv.tx(context);
            const data = { to: "me", subject: "subject", body: "body" };

            await service.send("action", data);
            await service.send("action", data);
            await commitAndOpenNew();
            await testHelper.selectEventQueueAndExpectOpen(tx, {
              expectedLength: 2,
            });
            await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
            await commitAndOpenNew();
            expect(loggerMock).actionCalledTimes("action", 1);
            await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
            expect(loggerMock.callsLengths().error).toEqual(0);
          });
        });

        it("specific and generic but no generic handler registered", async () => {
          const srv = await cds.connect.to(CUSTOM_HOOKS_SRV);
          const unboxedService = cds.unboxed(srv);
          const service = srv.tx(context);
          const data = { to: "to", subject: "subject", body: "body" };

          let handlerRegistration = {};
          for (const index in unboxedService.handlers.on) {
            const handler = unboxedService.handlers.on[index];
            if (handler.on === "eventQueueCluster") {
              handlerRegistration = { index, handler };
              delete unboxedService.handlers.on[index];
            }
          }

          await service.send("action", data);
          await service.send("main", data);
          await commitAndOpenNew();
          await testHelper.selectEventQueueAndExpectOpen(tx, {
            expectedLength: 2,
          });
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await commitAndOpenNew();
          await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
          expect(loggerMock.callsLengths().error).toEqual(0);
          unboxedService.handlers.on[handlerRegistration.index] = handlerRegistration.handler;
        });

        it("mixed generic and specific", async () => {
          const srv = await cds.connect.to(CUSTOM_HOOKS_SRV);
          const service = srv.tx(context);
          const data = { to: "to", subject: "subject", body: "body" };

          await service.send("action", data);
          await service.send("main", data);
          await commitAndOpenNew();
          await testHelper.selectEventQueueAndExpectOpen(tx, {
            expectedLength: 2,
          });
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await commitAndOpenNew();
          expect(loggerMock).actionCalledTimes("eventQueueCluster", 1);
          expect(loggerMock).actionCalledTimes("eventQueueCluster.action", 1);
          expect(loggerMock).actionCalledTimes("action", 1);
          expect(loggerMock).actionCalledTimes("main", 1);
          await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
          expect(loggerMock.callsLengths().error).toEqual(0);
        });

        it("mixed both generic - should not be possible to cluster across action", async () => {
          const srv = await cds.connect.to(CUSTOM_HOOKS_SRV);
          const service = srv.tx(context);
          const data = { to: "to", subject: "subject", body: "body" };

          await service.send("main", data);
          await service.send("anotherAction", data);
          await commitAndOpenNew();
          await testHelper.selectEventQueueAndExpectOpen(tx, {
            expectedLength: 2,
          });
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await commitAndOpenNew();
          expect(loggerMock).actionCalledTimes("eventQueueCluster", 2);
          expect(loggerMock).actionCalledTimes("main", 1);
          expect(loggerMock).actionCalledTimes("anotherAction", 1);
          await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
          expect(loggerMock.callsLengths().error).toEqual(0);
        });

        it("cluster returns invalid structure - should continue without clustering", async () => {
          const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
          const data = { to: "to", subject: "subject", body: "body" };
          await service.send("actionWithInvalidClusterReturn", data);
          await service.send("actionWithInvalidClusterReturn", data);
          await commitAndOpenNew();
          await testHelper.selectEventQueueAndExpectOpen(tx, {
            expectedLength: 2,
          });
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await commitAndOpenNew();
          expect(loggerMock).actionCalledTimes("eventQueueCluster.actionWithInvalidClusterReturn", 1);
          expect(loggerMock).actionCalledTimes("actionWithInvalidClusterReturn", 2);
          await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 2 });
          expect(loggerMock.callsLengths().error).toEqual(1);
        });

        it("cluster functions throws error", async () => {
          const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
          const data = { to: "to", subject: "subject", body: "body" };
          await service.send("throwErrorInCluster", data);
          await commitAndOpenNew();
          await testHelper.selectEventQueueAndExpectOpen(tx, {
            expectedLength: 1,
          });
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await commitAndOpenNew();
          expect(loggerMock).actionCalledTimes("eventQueueCluster.throwErrorInCluster", 1);
          expect(loggerMock).actionCalledTimes("throwErrorInCluster", 0);
          await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
          expect(loggerMock.callsLengths().error).toEqual(1);
        });
      });

      describe("hook for exceeded events", () => {
        it("generic call", async () => {
          const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
          const data = { to: "to", subject: "subject", body: "body" };
          await service.send("exceededAction", data);
          await commitAndOpenNew();
          await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
          await processEventQueue(tx.context, "CAP_OUTBOX", `${service.name}.exceededAction`);
          await commitAndOpenNew();
          expect(loggerMock).actionCalledTimes("exceededAction", 1);
          await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
          expect(loggerMock.callsLengths().error).toEqual(1);
          await commitAndOpenNew();
          await processEventQueue(tx.context, "CAP_OUTBOX", `${service.name}.exceededAction`);
          expect(loggerMock).actionCalledTimes("eventQueueRetriesExceeded", 1);
          const events = await testHelper.selectEventQueueAndReturn(tx, { expectedLength: 2 });
          expect(events).toMatchObject([
            {
              status: 0,
              attempts: 0,
              startAfter: null,
            },
            {
              status: 4,
              attempts: 2,
              startAfter: expect.any(String),
            },
          ]);
          expect(loggerMock.callsLengths().error).toEqual(1);
        });

        it("specific action call", async () => {
          const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
          const data = { to: "to", subject: "subject", body: "body" };
          await service.send("exceededActionSpecific", data);
          await commitAndOpenNew();
          await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
          await processEventQueue(tx.context, "CAP_OUTBOX", `${service.name}.exceededActionSpecific`);
          await commitAndOpenNew();
          expect(loggerMock).actionCalledTimes("exceededActionSpecific", 1);
          await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
          expect(loggerMock.callsLengths().error).toEqual(1);
          await commitAndOpenNew();
          await processEventQueue(tx.context, "CAP_OUTBOX", `${service.name}.exceededActionSpecific`);
          expect(loggerMock).actionCalledTimes("eventQueueRetriesExceeded.exceededActionSpecific", 1);
          expect(loggerMock.callsLengths().error).toEqual(1);
        });

        it("mixed", async () => {
          const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
          const data = { to: "to", subject: "subject", body: "body" };
          await service.send("main", data);
          await service.send("exceededActionSpecificMixed", data);
          await commitAndOpenNew();
          await tx.run(
            UPDATE("sap.eventqueue.Event").set({
              attempts: 20,
              status: EventProcessingStatus.Error,
              lastAttemptTimestamp: new Date(Date.now() - 1000),
            })
          );
          await commitAndOpenNew();
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await commitAndOpenNew();
          expect(loggerMock).actionCalledTimes("eventQueueRetriesExceeded", 1);
          expect(loggerMock).actionCalledTimes("eventQueueRetriesExceeded.exceededActionSpecificMixed", 1);
          await testHelper.selectEventQueueAndReturn(tx, { expectedLength: 4 });
          expect(loggerMock.callsLengths().error).toEqual(0);
        });

        it("error in exceeded hook should rollback exceeded tx", async () => {
          const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
          const data = { to: "to", subject: "subject", body: "body" };
          await service.send("exceededActionSpecificError", data);
          await commitAndOpenNew();
          await tx.run(
            UPDATE("sap.eventqueue.Event").set({
              attempts: 20,
              status: EventProcessingStatus.Error,
              lastAttemptTimestamp: new Date(Date.now() - 1000),
            })
          );
          await commitAndOpenNew();
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await commitAndOpenNew();
          expect(loggerMock).actionCalledTimes("eventQueueRetriesExceeded.exceededActionSpecificError", 1);
          await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
          expect(await tx.run(SELECT.one.from("sap.eventqueue.Lock").where("code = 'DummyTest'"))).toBeUndefined();
          expect(loggerMock.callsLengths().error).toEqual(1);
        });

        it("exceeded has max 3 retries", async () => {
          const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
          const data = { to: "to", subject: "subject", body: "body" };
          await service.send("exceededActionSpecificError", data);
          await commitAndOpenNew();
          await tx.run(
            UPDATE("sap.eventqueue.Event").set({
              attempts: 20,
              status: EventProcessingStatus.Error,
              lastAttemptTimestamp: new Date(Date.now() - 1000),
            })
          );
          await commitAndOpenNew();
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await commitAndOpenNew();
          expect(loggerMock).actionCalledTimes("eventQueueRetriesExceeded.exceededActionSpecificError", 1);
          await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
          expect(await tx.run(SELECT.one.from("sap.eventqueue.Lock").where("code = 'DummyTest'"))).toBeUndefined();
          expect(loggerMock.callsLengths().error).toEqual(1);

          await commitAndOpenNew();
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
          expect(loggerMock).actionCalledTimes("eventQueueRetriesExceeded.exceededActionSpecificError", 2);
          expect(loggerMock.callsLengths().error).toEqual(2);

          await commitAndOpenNew();
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await testHelper.selectEventQueueAndExpectError(tx, { expectedLength: 1 });
          expect(loggerMock).actionCalledTimes("eventQueueRetriesExceeded.exceededActionSpecificError", 3);
          expect(loggerMock.callsLengths().error).toEqual(3);

          await commitAndOpenNew();
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await testHelper.selectEventQueueAndExpectExceeded(tx, { expectedLength: 1 });
          expect(loggerMock).actionCalledTimes("eventQueueRetriesExceeded.exceededActionSpecificError", 3);
          expect(loggerMock.callsLengths().error).toEqual(4);
        });

        it("exceeded hook should be commited", async () => {
          const service = (await cds.connect.to("OutboxCustomHooks")).tx(context);
          const data = { to: "to", subject: "subject", body: "body" };
          await service.send("exceededActionWithCommit", data);
          await commitAndOpenNew();
          await tx.run(
            UPDATE("sap.eventqueue.Event").set({
              attempts: 20,
              status: EventProcessingStatus.Error,
              lastAttemptTimestamp: new Date(Date.now() - 1000),
            })
          );
          await commitAndOpenNew();
          await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
          await commitAndOpenNew();
          expect(loggerMock).actionCalledTimes("eventQueueRetriesExceeded.exceededActionWithCommit", 1);
          await testHelper.selectEventQueueAndExpectExceeded(tx, { expectedLength: 1 });
          expect(await tx.run(SELECT.one.from("sap.eventqueue.Lock").where("code = 'DummyTest'"))).toBeDefined();
          expect(loggerMock.callsLengths().error).toEqual(0);
        });
      });
    });

    describe("app names", () => {
      let env = getEnvInstance();
      beforeEach(() => {
        env.vcapApplication = {};
      });

      it("string - match", async () => {
        const service = (await cds.connect.to("AppNames")).tx(context);
        env.vcapApplication = { application_name: `srv-backend` };
        const data = { to: "to" };
        await service.send("appNamesString", data);
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        await processEventQueue(tx.context, "CAP_OUTBOX", "AppNames.appNamesString");
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("regex - no match", async () => {
        const service = (await cds.connect.to("AppNames")).tx(context);
        const data = { to: "to" };
        await service.send("appNamesRegex", data);
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        await processEventQueue(tx.context, "CAP_OUTBOX", "AppNames.appNamesRegex");
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("regex - match", async () => {
        const service = (await cds.connect.to("AppNames")).tx(context);
        env.vcapApplication = { application_name: `srv-backend-${cds.utils.uuid()}` };
        const data = { to: "to" };
        await service.send("appNamesRegex", data);
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        await processEventQueue(tx.context, "CAP_OUTBOX", "AppNames.appNamesRegex");
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("mix - regex no match - string match", async () => {
        const service = (await cds.connect.to("AppNames")).tx(context);
        env.vcapApplication = { application_name: `a-srv-backend` };
        const data = { to: "to" };
        await service.send("appNamesMixStringMatch", data);
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        await processEventQueue(tx.context, "CAP_OUTBOX", "AppNames.appNamesMixStringMatch");
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("mix - regex match - string no match", async () => {
        const service = (await cds.connect.to("AppNames")).tx(context);
        env.vcapApplication = { application_name: `a-srv-backend-${cds.utils.uuid()}` };
        const data = { to: "to" };
        await service.send("appNamesMixRegexMatch", data);
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        await processEventQueue(tx.context, "CAP_OUTBOX", "AppNames.appNamesMixRegexMatch");
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("mix - regex no match - string no match", async () => {
        const service = (await cds.connect.to("AppNames")).tx(context);
        env.vcapApplication = { application_name: `srv--backend` };
        const data = { to: "to" };
        await service.send("appNamesMixStringMatch", data);
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        await processEventQueue(tx.context, "CAP_OUTBOX", "AppNames.appNamesMixStringMatch");
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("mix - string no match - regex match", async () => {
        const service = (await cds.connect.to("AppNames")).tx(context);
        env.vcapApplication = { application_name: `srv-backend` };
        const data = { to: "to" };
        await service.send("appNamesReverseMixRegexMatch", data);
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        await processEventQueue(tx.context, "CAP_OUTBOX", "AppNames.appNamesReverseMixRegexMatch");
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
        expect(loggerMock.callsLengths().error).toEqual(0);
      });
    });

    describe("redisPubSub", () => {
      beforeAll(() => {
        config.isEventQueueActive = true;
      });

      afterAll(() => {
        config.isEventQueueActive = false;
      });

      it("should connect to CAP service - no specific configuration", async () => {
        const runnerSpy = jest.spyOn(runnerHelper, "runEventCombinationForTenant").mockResolvedValueOnce();
        const connectSpy = jest.spyOn(cds.connect, "to");
        const configSpy = jest.spyOn(config, "getCdsOutboxEventSpecificConfig");
        const configAddSpy = jest.spyOn(config, "addCAPOutboxEventSpecificAction");

        await redisSub.__._messageHandlerProcessEvents(
          JSON.stringify({
            type: "CAP_OUTBOX",
            subType: "OutboxCustomHooks",
          })
        );
        expect(runnerSpy).toHaveBeenCalledTimes(1);
        expect(connectSpy).toHaveBeenCalledTimes(0);
        expect(configSpy).toHaveBeenCalledTimes(1);
        expect(configAddSpy).toHaveBeenCalledTimes(0);
        expect(loggerMock.callsLengths()).toMatchObject({ error: 0, warn: 0 });
      });

      it("should connect to CAP service - specific configuration", async () => {
        const runnerSpy = jest.spyOn(runnerHelper, "runEventCombinationForTenant").mockResolvedValueOnce();
        const connectSpy = jest.spyOn(cds.connect, "to");
        const configSpy = jest.spyOn(config, "getCdsOutboxEventSpecificConfig");
        const configAddSpy = jest.spyOn(config, "addCAPOutboxEventSpecificAction");

        await redisSub.__._messageHandlerProcessEvents(
          JSON.stringify({
            type: "CAP_OUTBOX",
            subType: "OutboxCustomHooks.connectSpecific",
          })
        );
        expect(runnerSpy).toHaveBeenCalledTimes(1);
        expect(connectSpy).toHaveBeenCalledTimes(1);
        expect(connectSpy).toHaveBeenCalledWith("OutboxCustomHooks");
        expect(configSpy).toHaveBeenCalledTimes(3);
        expect(configAddSpy).toHaveBeenCalledTimes(1);
        expect(loggerMock.callsLengths()).toMatchObject({ error: 0, warn: 0 });
      });

      it("should connect to CAP service - specific configuration periodic event", async () => {
        const runnerSpy = jest.spyOn(runnerHelper, "runEventCombinationForTenant").mockResolvedValueOnce();
        const connectSpy = jest.spyOn(cds.connect, "to");
        const configSpy = jest.spyOn(config, "getCdsOutboxEventSpecificConfig");
        const configAddSpy = jest.spyOn(config, "addCAPOutboxEventSpecificAction");

        await redisSub.__._messageHandlerProcessEvents(
          JSON.stringify({
            type: "CAP_OUTBOX_PERIODIC",
            subType: "NotificationServicePeriodic.main",
          })
        );
        expect(runnerSpy).toHaveBeenCalledTimes(1);
        expect(connectSpy).toHaveBeenCalledTimes(0);
        expect(configSpy).toHaveBeenCalledTimes(1);
        expect(configAddSpy).toHaveBeenCalledTimes(0);
        expect(loggerMock.callsLengths()).toMatchObject({ error: 0, warn: 0 });
      });
    });

    describe("task queues", () => {
      it("use respect config in srv.queue", async () => {
        const service = (await cds.connect.to("QueueService")).tx(context);
        await service.send("timeBucketAction", {
          to: "to",
          subject: "subject",
          body: "body",
        });
        await commitAndOpenNew();
        const [event] = await testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 1,
          additionalColumns: ["subType", "createdAt"],
        });
        const pattern = cds.env.requires.QueueService.queued.events.timeBucketAction.timeBucket;
        const expectedDate = CronExpressionParser.parse(pattern, {
          currentDate: new Date(event.createdAt),
        })
          .next()
          .toISOString();
        expect(event.startAfter).toBeDefined();
        expect(expectedDate).toEqual(event.startAfter);
        expect(event.subType).toEqual("QueueService.timeBucketAction");
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("should also insert periodic events from queued", async () => {
        const subType = "QueueService.main";
        await checkAndInsertPeriodicEvents(context);
        const [periodicEvent] = await testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 1,
          additionalColumns: ["type", "subType"],
          subType,
        });
        await tx.run(UPDATE.entity("sap.eventqueue.Event").set({ startAfter: null }));

        await eventQueue.processEventQueue(context, periodicEvent.type, periodicEvent.subType);
        const [openEvent, processedEvent] = await testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 2,
          additionalColumns: ["type", "subType", "createdAt"],
          subType,
        });
        expect(openEvent).toMatchObject({
          status: 0,
          attempts: 0,
          type: "CAP_OUTBOX_PERIODIC",
          subType,
          startAfter: CronExpressionParser.parse("*/15 * * * * *", {
            currentDate: new Date(processedEvent.createdAt),
          })
            .next()
            .toISOString(),
        });
        expect(processedEvent).toMatchObject({
          status: 2,
          attempts: 1,
          type: "CAP_OUTBOX_PERIODIC",
          subType,
          startAfter: null,
        });
        expect(loggerMock.callsLengths().error).toEqual(0);
      });
    });

    describe("namespaces", () => {
      beforeEach(() => {
        config.processingNamespaces = [null, "namespaceA"];
      });

      it("should publish with namespace", async () => {
        const service = (await cds.connect.to("Namespace")).tx(context);
        await service.send("main", {
          to: "to",
          subject: "subject",
          body: "body",
        });
        await commitAndOpenNew();
        const [event] = await testHelper.selectEventQueueAndReturn(tx, {
          expectedLength: 1,
          additionalColumns: ["subType", "createdAt", "namespace"],
        });
        expect(event.namespace).toEqual("namespaceA");
      });

      it("should not process if different namespace", async () => {
        config.processingNamespaces = [null];
        const service = (await cds.connect.to("Namespace")).tx(context);
        await service.send("main", {
          to: "to",
          subject: "subject",
          body: "body",
        });
        await commitAndOpenNew();
        await processEventQueue(tx.context, "CAP_OUTBOX", service.name);
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectOpen(tx, { expectedLength: 1 });
        expect(loggerMock).not.sendFioriActionCalled();
        expect(loggerMock.callsLengths().error).toEqual(0);
      });

      it("should process in namespace", async () => {
        const service = (await cds.connect.to("Namespace")).tx(context);
        await service.send("main", {
          to: "to",
          subject: "subject",
          body: "body",
        });
        await commitAndOpenNew();
        await processEventQueue(tx.context, "CAP_OUTBOX", service.name, "namespaceA");
        await commitAndOpenNew();
        await testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 });
        expect(loggerMock).actionCalled("main");
        expect(loggerMock.callsLengths().error).toEqual(0);
      });
    });
  });

  const commitAndOpenNew = async () => {
    await tx.commit();
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
  };
});

expect.extend({
  sendFioriActionCalled: () => {
    return {
      message: () => "sendFiori Action not called",
      pass: loggerMock
        .calls()
        .info.map((call) => call[0])
        .includes("sendFiori action triggered"),
    };
  },
  actionCalledTimes: (loggerMock, actionName, count) => {
    const calls = loggerMock.calls().info.filter((c) => c[0] === actionName);
    return {
      message: () =>
        `expected number action of calls does not match! name: ${actionName}, expected: ${count}, actual: ${calls.length}`,
      // eslint-disable-next-line jest/no-standalone-expect
      pass: !expect(calls).toHaveLength(count),
    };
  },
  actionCalled: (loggerMock, actionName, properties = {}) => {
    const call = loggerMock.calls().info.find((c) => c[0] === actionName);
    if (!call) {
      return {
        message: () => `action not called! name: ${actionName}`,
        pass: false,
      };
    }

    return {
      message: () => `action called with different parameters! name: ${actionName}`,
      // eslint-disable-next-line jest/no-standalone-expect
      pass: !expect(call[1]).toMatchObject(properties),
    };
  },
});
