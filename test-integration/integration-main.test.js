"use strict";

const cds = require("@sap/cds");

cds.test(__dirname + "/_env");

describe("integration-main", () => {
  let context, tx, dbCounts;

  beforeAll(async () => {
    const db = await cds.connect.to("db");
    db.before("*", (cdsContext) => {
      if (dbCounts[cdsContext.event]) {
        dbCounts[cdsContext.event] = dbCounts[cdsContext.event] + 1;
      } else {
        dbCounts[cdsContext.event] = 1;
      }
    });
  });

  beforeEach(() => {
    context = new cds.EventContext({});
    tx = cds.tx(context);
    dbCounts = {};
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
    await tx.rollback();
    expect(eventQueueEntry).toHaveLength(0);
    expect(dbCounts).toMatchInlineSnapshot(`
      {
        "BEGIN": 1,
        "READ": 1,
        "ROLLBACK": 1,
      }
    `);
  });
});
