"use strict";

jest.mock("@opentelemetry/api", () => require("./mocks/openTelemetry"));
const { Logger: mockLogger } = require("./mocks/logger");

const cds = require("@sap/cds");

const project = __dirname + "/asset/outboxProject"; // The project's root folder
const { GET, PROMISE } = cds.test(project);

describe("admin-service-test", () => {
  let context, tx;

  beforeEach(async () => {
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await tx.rollback();
    jest.clearAllMocks();
  });

  afterAll(() => cds.shutdown);

  it("metadata snapshot", async () => {
    const data = await GET("/odata/v4/event-queue/admin");
    debugger;
  });
});
