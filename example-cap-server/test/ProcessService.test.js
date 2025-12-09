"use strict";

const cds = require("@sap/cds");
const eventQueue = require("@cap-js-community/event-queue");

const { GET, POST, axios } = cds.test(__dirname + "/..");
axios.defaults.auth = { username: "alice", password: "alice" };

describe("ProcessService OData APIs", () => {
  let log = cds.test.log();

  beforeEach(async () => {
    await DELETE.from("sap.eventqueue.Event");
  });

  it("serves ProcessService.C_ClosingTask", async () => {
    const { data } = await GET`/odata/v4/process/C_ClosingTask ${{ params: { $select: "ID,description" } }}`;
    expect(data.value).toHaveLength(0);
  });

  it("emit and process event via odata", async () => {
    const { data } = await POST(`/odata/v4/process/C_ClosingTask`, {
      description: "Demo Task for processing",
    });
    await POST(`/odata/v4/process/C_ClosingTask(${data.ID})/process`);

    let events = await SELECT.from("sap.eventqueue.Event");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "CAP_OUTBOX",
      subType: "task-service",
      status: 0,
    });

    await eventQueue.processEventQueue({}, "CAP_OUTBOX", "task-service");

    events = await SELECT.from("sap.eventqueue.Event").orderBy("createdAt");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "CAP_OUTBOX",
      subType: "task-service",
      status: 2,
    });

    expect(events[1]).toMatchObject({
      type: "CAP_OUTBOX",
      subType: "mail-service",
      status: 0,
    });
  });

  it("multiple tasks are clustered by 'to' property", async () => {
    const { data: task1 } = await POST(`/odata/v4/process/C_ClosingTask`, {
      description: "Demo Task for processing I",
    });
    const { data: task2 } = await POST(`/odata/v4/process/C_ClosingTask`, {
      description: "Demo Task for processing II",
    });
    await POST(`/odata/v4/process/C_ClosingTask(${task1.ID})/process`);
    await POST(`/odata/v4/process/C_ClosingTask(${task2.ID})/process`);

    let events = await SELECT.from("sap.eventqueue.Event");
    expect(events).toHaveLength(2);

    await eventQueue.processEventQueue({}, "CAP_OUTBOX", "task-service");

    events = await SELECT.from("sap.eventqueue.Event").orderBy("createdAt");
    expect(events).toHaveLength(4);

    await eventQueue.processEventQueue({}, "CAP_OUTBOX", "mail-service");

    const logs = parseLogEntries(log.output);
    const mailLogs = logs.filter((entry) => entry.includes("sending e-mail"));
    expect(mailLogs).toHaveLength(1);
    expect(mailLogs[0]).toMatchSnapshot();
  });
});

function parseLogEntries(logText) {
  const lines = logText.split(/\r?\n/);
  const entries = [];
  let current = [];

  for (const line of lines) {
    if (/^\[[^\]]+]\s+-/.test(line)) {
      // Start of a new entry
      if (current.length > 0) {
        entries.push(current.join("\n"));
      }
      current = [line];
    } else {
      // Continuation of previous entry
      current.push(line);
    }
  }

  // Push the final entry
  if (current.length > 0) {
    entries.push(current.join("\n"));
  }

  return entries;
}
