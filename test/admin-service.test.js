"use strict";

jest.mock("@opentelemetry/api", () => require("./mocks/openTelemetry"));
const { Logger: mockLogger } = require("./mocks/logger");

const cds = require("@sap/cds");

const project = __dirname + "./../"; // The project's root folder
const { GET } = cds.test(project);

const eventQueue = require("../src");

let loggerMock;

describe("admin-service-test", () => {
  let context, tx;

  beforeEach(async () => {
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
    jest.clearAllMocks();
    loggerMock = mockLogger();
  });

  afterEach(async () => {
    await tx.rollback();
    jest.clearAllMocks();
  });

  afterAll(() => cds.shutdown);

  it("not allowed if disabled by config", async () => {
    await expect(
      GET("/odata/v4/event-queue/admin/Event", { auth: { username: "yves", password: "" } })
    ).rejects.toMatchSnapshot();
    expect(loggerMock.callsLengths().error).toEqual(0);
  });

  it("metadata snapshot", async () => {
    eventQueue.config.enableAdminService = true;
    const response = await GET("/odata/v4/event-queue/admin/$metadata", { auth: { username: "yves", password: "" } });
    expect(response.data).toMatchSnapshot();
    expect(loggerMock.callsLengths().error).toEqual(0);
  });

  it("read entities", async () => {
    eventQueue.config.enableAdminService = true;
    const response = await GET("/odata/v4/event-queue/admin", { auth: { username: "yves", password: "" } });
    for (const entity of response.data.value) {
      const name = entity.name;
      const metadataResponse = await GET(`/odata/v4/event-queue/admin/${name}`, {
        auth: { username: "yves", password: "" },
      });
      expect(metadataResponse.data).toMatchSnapshot(name);
    }
    expect(loggerMock.callsLengths().error).toEqual(0);
  });
});
