"use strict";

const path = require("path");

const setTimeoutSpy = jest.spyOn(global, "setTimeout").mockImplementation((_, fn) => {
  fn();
});

const distributedLock = require("../src/shared/distributedLock");
const checkLockExistsSpy = jest.spyOn(distributedLock, "checkLockExistsAndReturnValue");
const config = require("../src/config");
const redisPub = require("../src/redis/redisPub");
const redisSub = require("../src/redis/redisSub");
const runnerHelper = require("../src/runner/runnerHelper");

const project = __dirname + "/.."; // The project's root folder
cds.test(project);

const eventQueue = require("../src");
const { insertEventEntry } = require("./helper");
const { Logger: mockLogger } = require("./mocks/logger");

let mockRedisPublishCalls = [];
let mockThrowErrorPublish = false;
jest.mock("../src/shared/redis", () => {
  return {
    createClientAndConnect: jest.fn().mockImplementation(() => {
      return {
        publish: jest.fn().mockImplementation((...args) => {
          if (mockThrowErrorPublish) {
            throw new Error("publish failed");
          }
          mockRedisPublishCalls.push(args);
        }),
      };
    }),
    publishMessage: jest.fn().mockImplementation((...args) => {
      if (mockThrowErrorPublish) {
        throw new Error("publish failed");
      }
      mockRedisPublishCalls.push(args);
    }),
    closeMainClient: () => {},
  };
});

const redis = require("../src/shared/redis");
const { getEnvInstance } = require("../src/shared/env");

describe("eventQueue Redis Events and DB Handlers", () => {
  let context;
  let tx;
  let loggerMock;
  beforeAll(async () => {
    const configFilePath = path.join(__dirname, "asset", "config.yml");
    await eventQueue.initialize({
      configFilePath,
      processEventsAfterPublish: true,
      isEventQueueActive: true,
    });
    config.redisEnabled = true;
    eventQueue.registerEventQueueDbHandler(cds.db);
    loggerMock = mockLogger();
    jest.spyOn(cds.utils, "uuid").mockReturnValue("6e31047a-d2b5-4e3c-83d8-deab20165956");
  });

  beforeEach(async () => {
    context = new cds.EventContext({ user: { id: "alice" } });
    tx = cds.tx(context);
    await tx.run(DELETE.from("sap.eventqueue.Event"));
    mockRedisPublishCalls = [];
    jest.clearAllMocks();
  });

  afterAll(() => cds.shutdown);

  describe("publish", () => {
    test("should not be called if not activated for the event", async () => {
      await insertEventEntry(tx, { type: "Test", subType: "NoProcessAfterCommit" });
      await tx.commit();
      expect(loggerMock.calls().error).toHaveLength(0);
      expect(mockRedisPublishCalls).toHaveLength(0);
    });

    test("db handler should be called if event is inserted", async () => {
      checkLockExistsSpy.mockResolvedValueOnce(false);
      await insertEventEntry(tx);
      await tx.commit();
      expect(loggerMock.calls().error).toHaveLength(0);
      expect(mockRedisPublishCalls).toHaveLength(1);
      expect(mockRedisPublishCalls[0]).toMatchInlineSnapshot(`
              [
                {},
                "EVENT_QUEUE_MESSAGE_CHANNEL",
                "{"lockId":"6e31047a-d2b5-4e3c-83d8-deab20165956","type":"Notifications","subType":"Task"}",
              ]
          `);
    });

    test("should do nothing no lock is available", async () => {
      checkLockExistsSpy.mockResolvedValueOnce(true);
      await insertEventEntry(tx);
      await tx.commit();
      expect(loggerMock.calls().error).toHaveLength(0);
      expect(mockRedisPublishCalls).toHaveLength(0);
    });

    test("should wait and try again if lock is not available for periodic events", async () => {
      await tx.rollback();
      const event = eventQueue.config.periodicEvents[0];
      checkLockExistsSpy.mockResolvedValueOnce(true);
      checkLockExistsSpy.mockResolvedValueOnce(false);

      await redisPub.broadcastEvent(123, { type: event.type, subType: event.subType });
      expect(loggerMock.calls().error).toHaveLength(0);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy.mock.lastCall[0]).toMatchInlineSnapshot(`30000`);
      expect(mockRedisPublishCalls).toHaveLength(1);
      expect(mockRedisPublishCalls[0]).toMatchInlineSnapshot(`
              [
                {},
                "EVENT_QUEUE_MESSAGE_CHANNEL",
                "{"lockId":"6e31047a-d2b5-4e3c-83d8-deab20165956","tenantId":123,"type":"HealthCheck_PERIODIC","subType":"DB"}",
              ]
          `);
    });

    test("should also try use retries if force parameter is set", async () => {
      await tx.rollback();
      const event = eventQueue.config.events[0];
      checkLockExistsSpy.mockResolvedValueOnce(true);
      checkLockExistsSpy.mockResolvedValueOnce(false);

      await redisPub.broadcastEvent(123, { type: event.type, subType: event.subType }, true);
      expect(loggerMock.calls().error).toHaveLength(0);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy.mock.lastCall[0]).toMatchInlineSnapshot(`30000`);
      expect(mockRedisPublishCalls).toHaveLength(1);
      expect(mockRedisPublishCalls[0]).toMatchInlineSnapshot(`
        [
          {},
          "EVENT_QUEUE_MESSAGE_CHANNEL",
          "{"lockId":"6e31047a-d2b5-4e3c-83d8-deab20165956","tenantId":123,"type":"Notifications","subType":"Task"}",
        ]
      `);
    });

    test("publish event should be called only once even if the same combination is inserted twice", async () => {
      checkLockExistsSpy.mockResolvedValueOnce(false);
      await insertEventEntry(tx, { numberOfEntries: 2 });
      await tx.commit();
      expect(mockRedisPublishCalls).toHaveLength(1);
      expect(mockRedisPublishCalls[0]).toMatchInlineSnapshot(`
              [
                {},
                "EVENT_QUEUE_MESSAGE_CHANNEL",
                "{"lockId":"6e31047a-d2b5-4e3c-83d8-deab20165956","type":"Notifications","subType":"Task"}",
              ]
          `);
    });

    test("publish event should be called only once even if the same combination is inserted twice - two inserts", async () => {
      checkLockExistsSpy.mockResolvedValueOnce(false);
      await insertEventEntry(tx, { numberOfEntries: 2 });
      await tx.commit();
      expect(mockRedisPublishCalls).toHaveLength(1);
      expect(mockRedisPublishCalls[0]).toMatchInlineSnapshot(`
              [
                {},
                "EVENT_QUEUE_MESSAGE_CHANNEL",
                "{"lockId":"6e31047a-d2b5-4e3c-83d8-deab20165956","type":"Notifications","subType":"Task"}",
              ]
          `);
    });

    test("different event combinations should result in two requests", async () => {
      checkLockExistsSpy.mockResolvedValue(false);
      await insertEventEntry(tx);
      await insertEventEntry(tx, { type: "Fiori", randomGuid: true });

      await tx.commit();
      expect(mockRedisPublishCalls).toHaveLength(2);
      expect(mockRedisPublishCalls).toMatchInlineSnapshot(`
              [
                [
                  {},
                  "EVENT_QUEUE_MESSAGE_CHANNEL",
                  "{"lockId":"6e31047a-d2b5-4e3c-83d8-deab20165956","type":"Notifications","subType":"Task"}",
                ],
                [
                  {},
                  "EVENT_QUEUE_MESSAGE_CHANNEL",
                  "{"lockId":"6e31047a-d2b5-4e3c-83d8-deab20165956","type":"Fiori","subType":"Task"}",
                ],
              ]
          `);
    });

    test("publish event throws an error", async () => {
      checkLockExistsSpy.mockResolvedValueOnce(false);
      const publishMessageSpy = jest.spyOn(redis, "publishMessage");
      await insertEventEntry(tx);
      mockThrowErrorPublish = true;
      await tx.commit();
      expect(mockRedisPublishCalls).toHaveLength(0);
      expect(publishMessageSpy).toHaveBeenCalledTimes(1);
      mockThrowErrorPublish = false;
    });
  });

  describe("subscribe handler", () => {
    afterEach(() => {
      config.isEventQueueActive = true;
    });

    test("straight forward should call runEventCombinationForTenant", async () => {
      const runnerSpy = jest.spyOn(runnerHelper, "runEventCombinationForTenant").mockResolvedValueOnce();
      checkLockExistsSpy.mockResolvedValueOnce(false);
      await insertEventEntry(tx);
      await tx.commit();

      expect(mockRedisPublishCalls).toHaveLength(1);
      await redisSub.__._messageHandlerProcessEvents(mockRedisPublishCalls[0][2]);
      expect(runnerSpy).toHaveBeenCalledTimes(1);
      expect(runnerSpy).toHaveBeenCalledWith(expect.any(Object), "Notifications", "Task", {
        lockId: expect.any(String),
        shouldTrace: true,
      });
    });

    test("should do nothing if isEventQueueActive=false", async () => {
      const runnerSpy = jest.spyOn(runnerHelper, "runEventCombinationForTenant").mockResolvedValueOnce();
      checkLockExistsSpy.mockResolvedValueOnce(false);
      await insertEventEntry(tx);
      await tx.commit();

      config.isEventQueueActive = false;
      expect(mockRedisPublishCalls).toHaveLength(1);
      await redisSub.__._messageHandlerProcessEvents(mockRedisPublishCalls[0][2]);
      expect(runnerSpy).toHaveBeenCalledTimes(0);
    });

    test("should not fail for not existing config", async () => {
      const runnerSpy = jest.spyOn(runnerHelper, "runEventCombinationForTenant").mockResolvedValueOnce();
      checkLockExistsSpy.mockResolvedValueOnce(false);
      await insertEventEntry(tx);
      await tx.commit();

      expect(mockRedisPublishCalls).toHaveLength(1);
      const data = JSON.parse(mockRedisPublishCalls[0][2]);

      await redisSub.__._messageHandlerProcessEvents({ ...data, type: "NOT_EXISTING" });
      expect(runnerSpy).toHaveBeenCalledTimes(0);
    });

    describe("should skip processing if not relevant for app", () => {
      test("appName", async () => {
        const runnerSpy = jest.spyOn(runnerHelper, "runEventCombinationForTenant").mockResolvedValueOnce();
        checkLockExistsSpy.mockResolvedValueOnce(false);
        await insertEventEntry(tx, { type: "AppSpecific", subType: "AppInstance" });
        await tx.commit();

        expect(mockRedisPublishCalls).toHaveLength(1);

        await redisSub.__._messageHandlerProcessEvents(mockRedisPublishCalls[0][2]);
        expect(runnerSpy).toHaveBeenCalledTimes(0);
      });

      test("appInstance", async () => {
        const runnerSpy = jest.spyOn(runnerHelper, "runEventCombinationForTenant").mockResolvedValueOnce();
        checkLockExistsSpy.mockResolvedValueOnce(false);
        await insertEventEntry(tx, { type: "AppSpecific", subType: "AppInstance" });
        await tx.commit();

        expect(mockRedisPublishCalls).toHaveLength(1);

        await redisSub.__._messageHandlerProcessEvents(mockRedisPublishCalls[0][2]);
        expect(runnerSpy).toHaveBeenCalledTimes(0);
      });

      test("combination", async () => {
        const env = getEnvInstance();
        env.vcapApplication = { application_name: "app-b" };
        env.applicationInstance = [1];
        const runnerSpy = jest.spyOn(runnerHelper, "runEventCombinationForTenant").mockResolvedValueOnce();
        checkLockExistsSpy.mockResolvedValueOnce(false);
        await insertEventEntry(tx, { type: "AppSpecific", subType: "both" });
        await tx.commit();

        expect(mockRedisPublishCalls).toHaveLength(1);

        await redisSub.__._messageHandlerProcessEvents(mockRedisPublishCalls[0][2]);
        expect(runnerSpy).toHaveBeenCalledTimes(0);
      });
    });
  });
});
