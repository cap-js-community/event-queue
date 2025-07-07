"use strict";

jest.mock("@opentelemetry/api", () => require("./mocks/openTelemetry"));
const { Logger: mockLogger } = require("./mocks/logger");

const cds = require("@sap/cds");

const project = __dirname + "./../"; // The project's root folder
const { GET, axios, POST } = cds.test(project);

const eventQueue = require("../src");
const testHelper = require("./helper");
const path = require("path");

let loggerMock;

describe("admin-service-test", () => {
  let context, tx;

  beforeAll(async () => {
    const configFilePath = path.join(__dirname, "asset", "config.yml");
    await eventQueue.initialize({
      configFilePath,
      processEventsAfterPublish: false,
      registerAsEventProcessor: false,
      useAsCAPOutbox: true,
    });
    axios.defaults.headers = {
      Authorization: `Basic ${Buffer.from("yves:", "utf8").toString("base64")}`,
    };
  });

  beforeEach(async () => {
    eventQueue.config.enableAdminService = true;
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
    await cds.tx({}, (tx) => tx.run(DELETE.from("sap.eventqueue.Event")));
    jest.clearAllMocks();
    loggerMock = mockLogger();
  });

  afterEach(async () => {
    await tx.rollback();
    jest.clearAllMocks();
  });

  afterAll(() => cds.shutdown);

  it("not allowed if disabled by config", async () => {
    eventQueue.config.enableAdminService = false;
    await expect(GET("/odata/v4/event-queue/admin/Event")).rejects.toMatchSnapshot();
    expect(loggerMock.callsLengths().error).toEqual(0);
  });

  it("metadata snapshot", async () => {
    const response = await GET("/odata/v4/event-queue/admin/$metadata");
    expect(response.data).toMatchSnapshot();
    expect(loggerMock.callsLengths().error).toEqual(0);
  });

  it("read entities", async () => {
    const response = await GET("/odata/v4/event-queue/admin");
    for (const entity of response.data.value) {
      const name = entity.name;
      const metadataResponse = await GET(`/odata/v4/event-queue/admin/${name}`, {
        auth: { username: "yves", password: "" },
      });
      expect(metadataResponse.data).toMatchSnapshot(name);
    }
    expect(loggerMock.callsLengths().error).toEqual(0);
  });

  it("read events", async () => {
    eventQueue.config.enableAdminService = true;
    await cds.tx({}, (tx) => testHelper.insertEventEntry(tx));
    const response = await GET("/odata/v4/event-queue/admin/Event");
    expect(response.data.value).toHaveLength(1);
    expect(response.data.value[0]).toMatchObject({
      type: "Notifications",
      subType: "Task",
      status: 0,
      attempts: 0,
    });
    expect(loggerMock.callsLengths().error).toEqual(0);
  });

  it("read event and set status", async () => {
    eventQueue.config.enableAdminService = true;
    await cds.tx({}, (tx) => testHelper.insertEventEntry(tx));
    const response = await GET("/odata/v4/event-queue/admin/Event");
    expect(response.data.value).toHaveLength(1);
    const { ID } = response.data.value[0];

    const responseSetStatus = await POST(`/odata/v4/event-queue/admin/Event/${ID}/setStatusAndAttempts`, {
      tenant: "local-dummy",
      status: eventQueue.EventProcessingStatus.Done,
      attempts: 1,
    });

    expect(responseSetStatus.data).toMatchObject({
      type: "Notifications",
      subType: "Task",
      status: 2,
      attempts: 1,
    });
  });
});
