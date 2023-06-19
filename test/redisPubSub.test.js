"use strict";

const distributedLock = require("../src/shared/distributedLock");
const checkLockExistsSpy = jest.spyOn(
  distributedLock,
  "checkLockExistsAndReturnValue"
);

const project = __dirname + "/.."; // The project's root folder
cds.test(project);

const eventQueue = require("../src");
const path = require("path");
const { insertEventEntry, getEventEntry } = require("./helper");
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
  };
});

describe("eventQueue Redis Events and DB Handlers", () => {
  let context;
  let tx;
  let loggerMock;
  beforeAll(async () => {
    const configFilePath = path.join(__dirname, "asset", "config.yml");
    const configInstance = eventQueue.getConfigInstance();
    await eventQueue.initialize({
      configFilePath,
      processEventsAfterPublish: true,
    });
    configInstance.redisEnabled = true;
    eventQueue.registerEventQueueDbHandler(cds.db);
    loggerMock = mockLogger();
    jest.spyOn(cds, "log").mockImplementation((layer) => {
      return mockLogger(layer);
    });
  });

  beforeEach(async () => {
    context = new cds.EventContext({ user: { id: "alice" } });
    tx = cds.tx(context);
    await tx.run(DELETE.from("sap.eventqueue.Event"));
    mockRedisPublishCalls = [];
  });

  afterAll(() => cds.shutdown);

  test("should not be called if not activated for the event", async () => {
    await tx.run(
      INSERT.into("sap.eventqueue.Event").entries({
        ...getEventEntry(),
        type: "Test",
        subType: "NoProcessAfterCommit",
      })
    );
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
        "cdsEventQueue",
        "{"type":"Notifications","subType":"Task"}",
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

  test("publish event should be called only once even if the same combination is inserted twice", async () => {
    checkLockExistsSpy.mockResolvedValueOnce(false);
    await insertEventEntry(tx, { numberOfEntries: 2 });
    await tx.commit();
    expect(mockRedisPublishCalls).toHaveLength(1);
    expect(mockRedisPublishCalls[0]).toMatchInlineSnapshot(`
      [
        "cdsEventQueue",
        "{"type":"Notifications","subType":"Task"}",
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
        "cdsEventQueue",
        "{"type":"Notifications","subType":"Task"}",
      ]
    `);
  });

  test("different event combinations should result in two requests", async () => {
    checkLockExistsSpy.mockResolvedValue(false);
    await insertEventEntry(tx);
    await tx.run(
      INSERT.into("sap.eventqueue.Event").entries({
        ...getEventEntry(),
        type: "Fiori",
      })
    );

    await tx.commit();
    expect(mockRedisPublishCalls).toHaveLength(2);
    expect(mockRedisPublishCalls).toMatchInlineSnapshot(`
      [
        [
          "cdsEventQueue",
          "{"type":"Notifications","subType":"Task"}",
        ],
        [
          "cdsEventQueue",
          "{"type":"Fiori","subType":"Task"}",
        ],
      ]
    `);
  });

  test("publish event throws an error", async () => {
    checkLockExistsSpy.mockResolvedValueOnce(false);
    await insertEventEntry(tx);
    mockThrowErrorPublish = true;
    await tx.commit();
    expect(mockRedisPublishCalls).toHaveLength(0);
    expect(loggerMock.callsLengths().error).toEqual(1);
    expect(loggerMock.calls().error).toMatchSnapshot();
    mockThrowErrorPublish = false;
  });
});
