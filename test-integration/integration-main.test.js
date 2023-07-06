"use strict";

const path = require("path");
const { promisify } = require("util");

const cds = require("@sap/cds");
cds.test(__dirname + "/_env");
const cdsHelper = require("../src/shared/cdsHelper");
jest.spyOn(cdsHelper, "getAllTenantIds").mockResolvedValue(null);

const eventQueue = require("../src");
const testHelper = require("../test/helper");
const EventQueueTest = require("../test/asset/EventQueueTest");
const { EventProcessingStatus } = require("../src");
const { Logger: mockLogger } = require("../test/mocks/logger");
const distributedLock = require("../src/shared/distributedLock");

let dbCounts = {};
describe("integration-main", () => {
  let context;
  let tx;
  let loggerMock;

  beforeAll(async () => {
    const configFilePath = path.join(
      __dirname,
      "..",
      "./test",
      "asset",
      "config.yml"
    );
    await eventQueue.initialize({
      configFilePath,
      processEventsAfterPublish: false,
      registerAsEventProcessor: false,
    });
    loggerMock = mockLogger();
    jest.spyOn(cds, "log").mockImplementation((layer) => {
      return mockLogger(layer);
    });
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
  });

  afterEach(async () => {
    await tx.rollback();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await cds.disconnect();
    await cds.shutdown();
  });

  it("empty queue - nothing to do", async () => {
    const event = eventQueue.getConfigInstance().events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    await testHelper.selectEventQueueAndExpectDone(tx, 0);
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(dbCounts).toMatchSnapshot();
  });

  it("insert one entry and process", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    dbCounts = {};
    const event = eventQueue.getConfigInstance().events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectDone(tx);
    expect(dbCounts).toMatchSnapshot();
  });

  it("if process event returns an error --> tx should be rolled backed", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    dbCounts = {};
    const event = eventQueue.getConfigInstance().events[0];
    jest
      .spyOn(EventQueueTest.prototype, "processEvent")
      .mockImplementationOnce(async (processContext, key, queueEntries) => {
        await cds.tx(processContext).run(SELECT.from("sap.eventqueue.Lock"));
        return queueEntries.map((queueEntry) => [
          queueEntry.ID,
          EventProcessingStatus.Error,
        ]);
      });
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectError(tx);
    expect(dbCounts).toMatchSnapshot();
  });

  it("if process event throws an error --> tx should be rolled backed", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    dbCounts = {};
    const event = eventQueue.getConfigInstance().events[0];
    jest
      .spyOn(EventQueueTest.prototype, "processEvent")
      .mockImplementationOnce(async (processContext) => {
        await cds.tx(processContext).run(SELECT.from("sap.eventqueue.Lock"));
        throw new Error("error during processing");
      });
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(1);
    await testHelper.selectEventQueueAndExpectError(tx);
    expect(dbCounts).toMatchSnapshot();
  });

  it("if cluster methods throws an error --> entry should not be processed + status should be error", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    dbCounts = {};
    const event = eventQueue.getConfigInstance().events[0];
    jest
      .spyOn(EventQueueTest.prototype, "clusterQueueEntries")
      .mockImplementationOnce(() => {
        throw new Error("error during processing");
      });
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(1);
    expect(loggerMock.calls().error).toMatchSnapshot();
    await testHelper.selectEventQueueAndExpectError(tx);
    expect(dbCounts).toMatchSnapshot();
  });

  it("if checkEventAndGeneratePayload methods throws an error --> entry should not be processed + status should be error", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    dbCounts = {};
    const event = eventQueue.getConfigInstance().events[0];
    jest
      .spyOn(EventQueueTest.prototype, "checkEventAndGeneratePayload")
      .mockImplementationOnce(() => {
        throw new Error("error during processing");
      });
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(1);
    expect(loggerMock.calls().error).toMatchSnapshot();
    await testHelper.selectEventQueueAndExpectError(tx);
    expect(dbCounts).toMatchSnapshot();
  });

  it("if modifyQueueEntry methods throws an error --> entry should not be processed + status should be error", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    dbCounts = {};
    const event = eventQueue.getConfigInstance().events[0];
    jest
      .spyOn(EventQueueTest.prototype, "modifyQueueEntry")
      .mockImplementationOnce(() => {
        throw new Error("error during processing");
      });
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(1);
    // TODO: should not be an unexpected error
    expect(loggerMock.calls().error).toMatchSnapshot();
    await testHelper.selectEventQueueAndExpectError(tx);
    expect(dbCounts).toMatchSnapshot();
  });

  it("two entries with no commit on event level", async () => {
    await cds.tx({}, (tx2) =>
      testHelper.insertEventEntry(tx2, { numberOfEntries: 2 })
    );
    dbCounts = {};
    const event = eventQueue.getConfigInstance().events[0];
    event.commitOnEventLevel = false;
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectDone(tx, 2);
    expect(dbCounts).toMatchSnapshot();
    event.commitOnEventLevel = true;
  });

  it("returning exceeded status should be allowed", async () => {
    await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
    const processSpy = jest
      .spyOn(EventQueueTest.prototype, "processEvent")
      .mockImplementationOnce((processContext, key, queueEntries) => {
        return queueEntries.map((queueEntry) => [
          queueEntry.ID,
          EventProcessingStatus.Exceeded,
        ]);
      });
    dbCounts = {};
    const event = eventQueue.getConfigInstance().events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectExceeded(tx, 1);
    expect(dbCounts).toMatchSnapshot();
    dbCounts = {};
    expect(processSpy).toHaveBeenCalledTimes(1);

    // Event should not be processed anymore
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectExceeded(tx, 1);
    expect(dbCounts).toMatchSnapshot();
    expect(processSpy).toHaveBeenCalledTimes(1);
  });

  it("should do nothing if lock for event combination cannot be acquired", async () => {
    const event = eventQueue.getConfigInstance().events[0];
    await cds.tx({}, async (tx2) => {
      await testHelper.insertEventEntry(tx2);
      await distributedLock.acquireLock(
        tx2.context,
        [event.type, event.subType].join("##")
      );
    });
    dbCounts = {};
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectOpen(tx, 1);
    expect(dbCounts).toMatchSnapshot();
  });

  it("commitOnEventLevel=false + first processed register tx rollback", async () => {
    const event = eventQueue.getConfigInstance().events[0];
    await cds.tx({}, async (tx2) => {
      await testHelper.insertEventEntry(tx2, { numberOfEntries: 2 });
    });
    dbCounts = {};
    jest
      .spyOn(EventQueueTest.prototype, "processEvent")
      .mockImplementationOnce(async function (
        processContext,
        key,
        queueEntries
      ) {
        this.setShouldRollbackTransaction(key);
        await this.getTxForEventProcessing(key).run(
          SELECT.from("sap.eventqueue.Event")
        );
        return queueEntries.map((queueEntry) => [
          queueEntry.ID,
          EventProcessingStatus.Done,
        ]);
      })
      .mockImplementationOnce(async function (
        processContext,
        key,
        queueEntries
      ) {
        await this.getTxForEventProcessing(key).run(
          SELECT.from("sap.eventqueue.Event")
        );
        return queueEntries.map((queueEntry) => [
          queueEntry.ID,
          EventProcessingStatus.Done,
        ]);
      });
    event.commitOnEventLevel = false;
    event.parallelEventProcessing = 1;
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectDone(tx, 2);
    expect(dbCounts).toMatchSnapshot();
    event.commitOnEventLevel = false;
  });

  it("commitOnEventLevel=true + first processed register tx rollback - one should be roll back", async () => {
    const event = eventQueue.getConfigInstance().events[0];
    await cds.tx({}, async (tx2) => {
      await testHelper.insertEventEntry(tx2, { numberOfEntries: 2 });
    });
    dbCounts = {};
    jest
      .spyOn(EventQueueTest.prototype, "processEvent")
      .mockImplementationOnce(async function (
        processContext,
        key,
        queueEntries
      ) {
        this.setShouldRollbackTransaction(key);
        await this.getTxForEventProcessing(key).run(
          SELECT.from("sap.eventqueue.Event")
        );
        return queueEntries.map((queueEntry) => [
          queueEntry.ID,
          EventProcessingStatus.Done,
        ]);
      })
      .mockImplementationOnce(async function (
        processContext,
        key,
        queueEntries
      ) {
        await this.getTxForEventProcessing(key).run(
          SELECT.from("sap.eventqueue.Event")
        );
        return queueEntries.map((queueEntry) => [
          queueEntry.ID,
          EventProcessingStatus.Done,
        ]);
      });
    event.commitOnEventLevel = true;
    event.parallelEventProcessing = 1;
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectDone(tx, 2);
    expect(dbCounts).toMatchSnapshot();
    event.commitOnEventLevel = false;
  });

  it("commitOnEventLevel=true + both processed register tx rollback - both should be roll back", async () => {
    const event = eventQueue.getConfigInstance().events[0];
    await cds.tx({}, async (tx2) => {
      await testHelper.insertEventEntry(tx2, { numberOfEntries: 2 });
    });
    dbCounts = {};
    jest
      .spyOn(EventQueueTest.prototype, "processEvent")
      .mockImplementationOnce(async function (
        processContext,
        key,
        queueEntries
      ) {
        this.setShouldRollbackTransaction(key);
        await this.getTxForEventProcessing(key).run(
          SELECT.from("sap.eventqueue.Event")
        );
        return queueEntries.map((queueEntry) => [
          queueEntry.ID,
          EventProcessingStatus.Done,
        ]);
      })
      .mockImplementationOnce(async function (
        processContext,
        key,
        queueEntries
      ) {
        this.setShouldRollbackTransaction(key);
        await this.getTxForEventProcessing(key).run(
          SELECT.from("sap.eventqueue.Event")
        );
        return queueEntries.map((queueEntry) => [
          queueEntry.ID,
          EventProcessingStatus.Done,
        ]);
      });
    event.commitOnEventLevel = true;
    event.parallelEventProcessing = 1;
    await eventQueue.processEventQueue(context, event.type, event.subType);
    expect(loggerMock.callsLengths().error).toEqual(0);
    await testHelper.selectEventQueueAndExpectDone(tx, 2);
    expect(dbCounts).toMatchSnapshot();
    event.commitOnEventLevel = false;
  });

  describe("end-to-end", () => {
    beforeAll(async () => {
      eventQueue.getConfigInstance().initialized = false;
      const configFilePath = path.join(
        __dirname,
        "..",
        "./test",
        "asset",
        "config.yml"
      );
      await eventQueue.initialize({
        configFilePath,
        processEventsAfterPublish: true,
      });
    });

    it("insert entry, entry should be automatically processed", async () => {
      await cds.tx({}, (tx2) => testHelper.insertEventEntry(tx2));
      await waitEntryIsDone();
      expect(loggerMock.callsLengths().error).toEqual(0);
      await testHelper.selectEventQueueAndExpectDone(tx);
      expect(dbCounts).toMatchSnapshot();
    });
  });
});

const waitEntryIsDone = async () => {
  let startTime = Date.now();
  while (true) {
    const row = await cds.tx({}, (tx2) =>
      tx2.run(SELECT.one.from("sap.eventqueue.Event"))
    );
    dbCounts["BEGIN"]--;
    dbCounts["COMMIT"]--;
    dbCounts["READ"]--;
    if (row.status === EventProcessingStatus.Done) {
      break;
    }
    if (Date.now() - startTime > 10 * 1000) {
      throw new Error("entry not completed");
    }
    await promisify(setTimeout)(50);
  }
  return false;
};
