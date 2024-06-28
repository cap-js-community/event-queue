"use strict";

const cds = require("@sap/cds");

const eventQueue = require("./src");
const COMPONENT_NAME = "/eventQueue/plugin";

if (!cds.build?.register && Object.keys(cds.env.eventQueue ?? {}).length) {
  module.exports = eventQueue.initialize().catch((err) => cds.log(COMPONENT_NAME).error(err));
}
