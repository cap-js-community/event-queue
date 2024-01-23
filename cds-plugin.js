"use strict";

const cds = require("@sap/cds");

const eventQueue = require("./src");
const COMPONENT_NAME = "/eventQueue/plugin";

const eventQueueConfig = cds.env.eventQueue;
if (!(cds.build.register || (!eventQueueConfig?.config && !eventQueueConfig?.configFilePath))) {
  eventQueue.initialize().catch((err) => cds.log(COMPONENT_NAME).error(err));
}
