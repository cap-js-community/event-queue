"use strict";

const parsedCdsOptions = JSON.parse(process.env.CDS_CONFIG ?? "{}");

parsedCdsOptions.requires ??= {};
parsedCdsOptions.requires.outbox = "persistent-outbox";

process.env.NEW_DB_SERVICE = process.env.NEW_DB_SERVICE === "true";
if (!process.env.NEW_DB_SERVICE) {
  parsedCdsOptions.requires.db = {
    kind: "legacy-sqlite",
    credentials: {
      url: ":memory:",
    },
  };
}
process.env.CDS_CONFIG = JSON.stringify(parsedCdsOptions);

// turn off regular and error logging;
jest.spyOn(console, "log").mockImplementation();
jest.spyOn(console, "info").mockImplementation();
jest.spyOn(console, "warn").mockImplementation();
