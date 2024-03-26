"use strict";

const cds = require("@sap/cds");

const eventQueue = require("./src");
const COMPONENT_NAME = "/eventQueue/plugin";

if (!cds.build.register && cds.env.eventQueue) {
  module.exports = eventQueue.initialize().catch((err) => cds.log(COMPONENT_NAME).error(err));
}
