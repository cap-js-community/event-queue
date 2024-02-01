"use strict";

process.env.CDS_CONFIG = '{ "requires": { "outbox": "persistent-outbox" } }';

// turn off regular and error logging;
// jest.spyOn(console, "log").mockImplementation();
// jest.spyOn(console, "info").mockImplementation();
jest.spyOn(console, "warn").mockImplementation();
jest.spyOn(console, "error").mockImplementation();
// jest.spyOn(process.stdout, "write").mockImplementation();
// jest.spyOn(process.stderr, "write").mockImplementation();
