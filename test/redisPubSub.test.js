"use strict";

const env = require("../src/shared/env");
env.isOnCF = true;
const distributedLock = require("../src/shared/distributedLock");
const checkLockExistsSpy = jest.spyOn(distributedLock, "checkLockExists");

const project = __dirname + "/.."; // The project's root folder
cds.test(project);

const eventQueue = require("../src");
const path = require("path");
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
  let queueEntry;

  beforeAll(async () => {
    const configFilePath = path.join(__dirname, "asset", "config.yml");
    const configInstance = eventQueue.getConfigInstance();
    await eventQueue.initialize({ configFilePath, registerDbHandler: true });
    configInstance.redisEnabled = true;
    eventQueue.registerEventQueueDbHandler(cds.db);
    const event = eventQueue.getConfigInstance().events[0];
    queueEntry = {
      type: event.type,
      subType: event.subType,
      referenceEntityKey: "4c67b466-f409-4834-a0fd-0fa22f3fb620",
      payload:
        '{"taskListId":"4c67b466-f409-4834-a0fd-0fa22f3fb620","notificationConfigurationId":"5e9254d9-685c-4600-b3c3-41501da02814"}',
    };
  });

  beforeEach(async () => {
    context = new cds.EventContext({ user: { id: "alice" } });
    tx = cds.tx(context);
    await tx.run(DELETE.from("sap.core.EventQueue"));
    mockRedisPublishCalls = [];
  });

  test("db handler should be called if event is inserted", async () => {
    checkLockExistsSpy.mockResolvedValueOnce(false);
    await tx.run(
      INSERT.into("sap.core.EventQueue").entries({
        ...queueEntry,
      })
    );
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
    await tx.run(
      INSERT.into("sap.core.EventQueue").entries({
        ...queueEntry,
      })
    );
    await tx.commit();
    expect(loggerMock.calls().error).toHaveLength(0);
    expect(mockRedisPublishCalls).toHaveLength(0);
  });

  test("publish event should be called only once even if the same combination is inserted twice", async () => {
    checkLockExistsSpy.mockResolvedValueOnce(false);
    await tx.run(
      INSERT.into("sap.core.EventQueue").entries([
        { ...queueEntry },
        { ...queueEntry },
      ])
    );
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
    await tx.run(
      INSERT.into("sap.core.EventQueue").entries({
        ...queueEntry,
      })
    );
    await tx.run(
      INSERT.into("sap.core.EventQueue").entries({
        ...queueEntry,
      })
    );
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
    await tx.run(
      INSERT.into("sap.core.EventQueue").entries({
        ...queueEntry,
      })
    );
    await tx.run(
      INSERT.into("sap.core.EventQueue").entries({
        ...queueEntry,
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
