"use strict";

const path = require("path");

const cds = require("@sap/cds/lib");

const eventQueue = require("../src");
const testHelper = require("./helper");
jest.mock("../src/shared/logger", () => require("./mocks/logger"));
const loggerMock = require("../src/shared/logger").Logger();

const project = __dirname + "/.."; // The project's root folder
cds.test(project);

describe("baseFunctionality", () => {
  let context, tx;

  beforeAll(async () => {
    const configFilePath = path.join(__dirname, "asset", "config.yml");
    await eventQueue.initialize({ configFilePath });
  });

  beforeEach(async () => {
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
    await tx.run(DELETE.from("sap.core.EventLock"));
    await tx.run(DELETE.from("sap.core.EventQueue"));
  });

  afterEach(async () => {
    await tx.rollback();
    jest.clearAllMocks();
  });

  it("empty queue - nothing to do", async () => {
    const event = eventQueue.getConfigInstance().events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
  });

  it("insert one entry and process", async () => {
    await testHelper.insertEventEntry(tx);
    const event = eventQueue.getConfigInstance().events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectDone(tx);
  });

  it("should do nothing if no lock is available", async () => {
    await testHelper.insertEventEntry(tx);
    jest
      .spyOn(
        eventQueue.EventQueueProcessorBase.prototype,
        "handleDistributedLock"
      )
      .mockResolvedValueOnce(false);
    const event = eventQueue.getConfigInstance().events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectOpen(tx);
  });

  describe("error handling", () => {
    it("missing event implementation", async () => {
      await testHelper.insertEventEntry(tx);
      await eventQueue.processEventQueue(context, "404", "NOT FOUND");
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchInlineSnapshot(`
        [
          [
            "No Implementation found for queue type in 'eventTypeRegister.js'",
            {
              "eventSubType": "NOT FOUND",
              "eventType": "404",
            },
          ],
        ]
      `);
      await testHelper.selectEventQueueAndExpectOpen(tx);
    });

    it("handle handleDistributedLock fails", async () => {
      await testHelper.insertEventEntry(tx);
      jest
        .spyOn(
          eventQueue.EventQueueProcessorBase.prototype,
          "handleDistributedLock"
        )
        .mockRejectedValueOnce(new Error("lock require failed"));
      const event = eventQueue.getConfigInstance().events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchInlineSnapshot(`
        [
          [
            "Processing event queue failed with unexpected error",
            [Error: lock require failed],
          ],
        ]
      `);
      await testHelper.selectEventQueueAndExpectOpen(tx);
    });
  });
});
