"use strict";

const cds = require("@sap/cds");

cds.test(__dirname + "/_env");

describe("integration-main", () => {
  let context, tx;

  beforeEach(() => {
    context = new cds.EventContext({});
    tx = cds.tx(context);
  });

  afterEach(async () => {
    await tx.rollback();
  });

  afterAll(async () => {
    await cds.disconnect();
    await cds.shutdown();
  });

  it("Test Setup", async () => {
    const eventQueueEntry = await tx.run(SELECT.from("sap.core.EventQueue"));
    expect(eventQueueEntry).toHaveLength(0);
  });
});
