"use strict";

const cds = require("@sap/cds");
cds.setMaxListeners(0);

const parsedCdsOptions = JSON.parse(process.env.CDS_CONFIG ?? "{}");

parsedCdsOptions.requires ??= {};
parsedCdsOptions.requires.outbox = "persistent-outbox";
parsedCdsOptions.requires["event-queue"] = false;

process.env.CDS_CONFIG = JSON.stringify(parsedCdsOptions);

// turn off regular and error logging;
jest.spyOn(console, "log").mockImplementation();
jest.spyOn(console, "info").mockImplementation();
jest.spyOn(console, "warn").mockImplementation();
