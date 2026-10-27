"use strict";

const cds = require("@sap/cds");
cds.setMaxListeners(0);

const parsedCdsOptions = JSON.parse(process.env.CDS_CONFIG ?? "{}");

parsedCdsOptions.requires ??= {};
parsedCdsOptions.requires.outbox = "persistent-outbox";

// Prevent loading own module in test as already served via srv
parsedCdsOptions.requires["event-queue"] = {
  model: null,
};

process.env.CDS_CONFIG = JSON.stringify(parsedCdsOptions);

// turn off regular and error logging;
jest.spyOn(console, "log").mockImplementation();
jest.spyOn(console, "info").mockImplementation();
jest.spyOn(console, "warn").mockImplementation();

// scheduled event timers outlive the test file and log into a torn down environment
afterAll(() => {
  const eventScheduler = require("./src/shared/eventScheduler").getInstance();
  for (const tenantId of Object.keys(eventScheduler.eventsByTenants)) {
    eventScheduler.clearForTenant(tenantId);
  }
});
