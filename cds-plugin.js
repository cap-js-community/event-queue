"use strict";

const cds = require("@sap/cds");

const eventQueue = require("./src");

if (cds.env.eventQueue && cds.env.eventQueue.plugin) {
  cds.on("bootstrap", async () => {
    await eventQueue.initialize();
  });
}
