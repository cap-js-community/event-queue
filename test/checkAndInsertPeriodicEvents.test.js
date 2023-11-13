"use strict";

const path = require("path");

const cds = require("@sap/cds/lib");

const eventQueue = require("../src");
const { Logger: mockLogger } = require("./mocks/logger");
const { checkAndInsertPeriodicEvents } = require("../src/checkAndInsertPeriodicEvents");
const { getConfigInstance } = require("../src/config");
const { selectEventQueueAndReturn } = require("./helper");
const project = __dirname + "/.."; // The project's root folder
cds.test(project);

describe("baseFunctionality", () => {
  let loggerMock, context, tx;
  beforeAll(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(1699873200000));
    const configFilePath = path.join(__dirname, "asset", "config.yml");
    await eventQueue.initialize({
      configFilePath,
      processEventsAfterPublish: false,
      registerAsEventProcessor: false,
      updatePeriodicEvents: false,
    });
    loggerMock = mockLogger();
    jest.spyOn(cds, "log").mockImplementation((layer) => {
      return mockLogger(layer);
    });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
    await tx.run(DELETE.from("sap.eventqueue.Lock"));
    await tx.run(DELETE.from("sap.eventqueue.Event"));
  });

  afterEach(async () => {
    await tx.rollback();
  });

  it("basic insert all new events", async () => {
    await checkAndInsertPeriodicEvents(context);

    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(loggerMock.calls().info).toMatchSnapshot();
    expect(await selectEventQueueAndReturn(tx)).toMatchSnapshot();
  });

  it("delta insert", async () => {
    await checkAndInsertPeriodicEvents(context);

    const fileContent = getConfigInstance().fileContent;
    fileContent.periodicEvents.push({
      ...getConfigInstance().fileContent.periodicEvents[0],
      subType: "DB2",
    });
    getConfigInstance().fileContent = fileContent;

    await checkAndInsertPeriodicEvents(context);

    fileContent.periodicEvents.splice(1, 1);
    getConfigInstance().fileContent = fileContent;
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(loggerMock.calls().info).toMatchSnapshot();
    expect(await selectEventQueueAndReturn(tx, 2)).toMatchSnapshot();
  });

  it("interval changed", async () => {
    await checkAndInsertPeriodicEvents(context);
    const eventConfig = getConfigInstance().periodicEvents[0];
    eventConfig.interval = 10;

    await tx.run(
      UPDATE.entity("sap.eventqueue.Event").set({
        startAfter: new Date(1699873200000 + 30 * 1000),
      })
    );
    await checkAndInsertPeriodicEvents(context);

    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(loggerMock.calls().info).toMatchSnapshot();
    expect(await selectEventQueueAndReturn(tx, 1)).toMatchSnapshot();
  });
});
