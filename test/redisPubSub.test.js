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
jest.mock("../src/shared/logger", () => require("./mocks/logger"));
const loggerMock = require("../src/shared/logger").Logger();

let mockRedisPublishCalls = [];
jest.mock("@sap/btp-feature-toggles/src/redisWrapper", () => {
  return {
    _: {
      _createClientAndConnect: jest.fn().mockImplementation(() => {
        return {
          publish: jest.fn().mockImplementation((...args) => {
            mockRedisPublishCalls.push(args);
          }),
        };
      }),
      _getLogger: () => ({}),
    },
  };
});

describe("eventQueue Redis Events and DB Handlers", () => {
  let context;
  let tx;
  beforeAll(async () => {
    const configFilePath = path.join(__dirname, "asset", "config.yml");
    const configInstance = eventQueue.getConfigInstance();
    await eventQueue.initialize({ configFilePath, registerDbHandler: true });
    configInstance.redisEnabled = true;
    eventQueue.registerEventQueueDbHandler(cds.db);
  });

  beforeEach(async () => {
    context = new cds.EventContext({ user: { id: "alice" } });
    tx = cds.tx(context);
    await tx.run(DELETE.from("sap.core.EventQueue"));
    mockRedisPublishCalls = [];
  });

  test("should not be called if not activated for the event", async () => {
    await tx.run(
      INSERT.into("sap.core.EventQueue").entries({
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
      INSERT.into("sap.core.EventQueue").entries({
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
});
