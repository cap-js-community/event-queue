"use strict";

const cds = require("@sap/cds");

cds.test(__dirname + "/_env");

const eventQueue = require("../src");
const testHelper = require("../test/helper");
const path = require("path");
jest.mock("../src/shared/logger", () => require("../test/mocks/logger"));
const loggerMock = require("../src/shared/logger").Logger();

describe("integration-main", () => {
  let context;
  let tx;
  let dbCounts = {};

  beforeAll(async () => {
    const configFilePath = path.join(
      __dirname,
      "..",
      "./test",
      "asset",
      "config.yml"
    );
    await eventQueue.initialize({ configFilePath, registerDbHandler: false });
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
      await tx2.run(DELETE.from("sap.core.EventLock"));
      await tx2.run(DELETE.from("sap.core.EventQueue"));
    });
    dbCounts = {};
  });

  afterEach(async () => {
    await tx.rollback();
  });

  afterAll(async () => {
    await cds.disconnect();
    await cds.shutdown();
  });

  it("empty queue - nothing to do", async () => {
    const event = eventQueue.getConfigInstance().events[0];
    await eventQueue.processEventQueue(context, event.type, event.subType);
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
});
