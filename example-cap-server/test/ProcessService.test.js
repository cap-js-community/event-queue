"use strict";

const cds = require("@sap/cds");
const eventQueue = require("@cap-js-community/event-queue");

const { GET, POST, expect, axios } = cds.test(__dirname + "/..");
axios.defaults.auth = { username: "alice", password: "alice" };

describe("ProcessService OData APIs", () => {
  it("serves ProcessService.C_ClosingTask", async () => {
    const { data } = await GET`/odata/v4/process/C_ClosingTask ${{ params: { $select: "ID,description" } }}`;
    expect(data.value).to.be.empty;
  });

  it("emit and process event via odata", async () => {
    let { data } = await POST(`/odata/v4/process/C_ClosingTask`, {
      description: "Demo Task for processing",
    });

    await POST(`/odata/v4/process/C_ClosingTask(${data.ID})/process`);

    let events = await SELECT.from("sap.eventqueue.Event");
    expect(events).to.have.lengthOf(1);
    expect(events[0]).to.nested.include({
      type: "CAP_OUTBOX",
      subType: "task-service",
      status: 0,
    });

    await eventQueue.processEventQueue({}, "CAP_OUTBOX", "task-service");

    events = await SELECT.from("sap.eventqueue.Event").orderBy("createdAt");
    expect(events).to.have.lengthOf(2);
    expect(events[0]).to.nested.include({
      type: "CAP_OUTBOX",
      subType: "task-service",
      status: 2,
    });

    expect(events[1]).to.nested.include({
      type: "CAP_OUTBOX",
      subType: "mail-service",
      status: 0,
    });
  });
});
