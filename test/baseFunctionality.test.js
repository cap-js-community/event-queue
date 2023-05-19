"use strict";

const path = require("path");

const cds = require("@sap/cds/lib");

const eventQueue = require("../src");
const testHelper = require("./helper");
const EventQueueTest = require("./asset/EventQueueTest");
jest.mock("../src/shared/logger", () => require("./mocks/logger"));
const loggerMock = require("../src/shared/logger").Logger();

const project = __dirname + "/.."; // The project's root folder
cds.test(project);

describe("baseFunctionality", () => {
  let context, tx;

  beforeAll(async () => {
    const configFilePath = path.join(__dirname, "asset", "config.yml");
    await eventQueue.initialize({ configFilePath, registerDbHandler: false });
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

  afterAll(() => cds.shutdown);

  test("empty queue - nothing to do", async () => {
    const event = eventQueue.getConfigInstance().events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
  });

  test("insert one entry and process", async () => {
    await testHelper.insertEventEntry(tx);
    const event = eventQueue.getConfigInstance().events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectDone(tx);
  });

  test("should do nothing if no lock is available", async () => {
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
    test("missing event implementation", async () => {
      await testHelper.insertEventEntry(tx);
      await eventQueue.processEventQueue(context, "404", "NOT FOUND");
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
      await testHelper.selectEventQueueAndExpectOpen(tx);
    });

    test("handle handleDistributedLock fails", async () => {
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
      expect(loggerMock.calls().error).toMatchSnapshot();
      await testHelper.selectEventQueueAndExpectOpen(tx);
    });

    test("handle getQueueEntriesAndSetToInProgress fails", async () => {
      await testHelper.insertEventEntry(tx);
      jest
        .spyOn(
          eventQueue.EventQueueProcessorBase.prototype,
          "getQueueEntriesAndSetToInProgress"
        )
        .mockRejectedValueOnce(new Error("db error"));
      const event = eventQueue.getConfigInstance().events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
      await testHelper.selectEventQueueAndExpectOpen(tx);
    });

    test("handle modifyQueueEntry fails", async () => {
      await testHelper.insertEventEntry(tx);
      jest
        .spyOn(eventQueue.EventQueueProcessorBase.prototype, "modifyQueueEntry")
        .mockImplementationOnce(() => {
          throw new Error("syntax error");
        });
      const event = eventQueue.getConfigInstance().events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
      await testHelper.selectEventQueueAndExpectError(tx);
    });

    test("handle checkEventAndGeneratePayload fails", async () => {
      await testHelper.insertEventEntry(tx);
      jest
        .spyOn(EventQueueTest.prototype, "checkEventAndGeneratePayload")
        .mockRejectedValueOnce(new Error("syntax error"));
      const event = eventQueue.getConfigInstance().events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
      await testHelper.selectEventQueueAndExpectError(tx);
    });

    test("handle clusterQueueEntries fails", async () => {
      await testHelper.insertEventEntry(tx);
      jest
        .spyOn(
          eventQueue.EventQueueProcessorBase.prototype,
          "clusterQueueEntries"
        )
        .mockImplementationOnce(() => {
          throw new Error("syntax error");
        });
      const event = eventQueue.getConfigInstance().events[0];
      await eventQueue.processEventQueue(context, event.type, event.subType);
      expect(loggerMock.callsLengths().error).toEqual(1);
      expect(loggerMock.calls().error).toMatchSnapshot();
      await testHelper.selectEventQueueAndExpectError(tx);
    });
  });

  describe("insert events", () => {
    test("straight forward", async () => {
      const event = eventQueue.getConfigInstance().events[0];
      await eventQueue.publishEvent(tx, {
        type: event.type,
        subType: event.subType,
        payload: JSON.stringify({
          testPayload: 123,
        }),
      });
      const events = await tx.run(SELECT.from("sap.core.EventQueue"));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: event.type,
        subType: event.subType,
        payload: JSON.stringify({
          testPayload: 123,
        }),
      });
    });

    test("unknown event", async () => {
      try {
        await eventQueue.publishEvent(tx, {
          type: "404",
          subType: "NOT FOUND",
          payload: JSON.stringify({
            testPayload: 123,
          }),
        });
      } catch (err) {
        expect(err.toString()).toMatchInlineSnapshot(`"EventQueueError"`);
      }
      const events = await tx.run(SELECT.from("sap.core.EventQueue"));
      expect(events).toHaveLength(0);
    });
  });
});
