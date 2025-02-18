"use strict";

const cds = require("@sap/cds");
const cdsPackage = require("@sap/cds/package.json");

const eventQueue = require("./src");
const EventQueueError = require("./src/EventQueueError");
const COMPONENT_NAME = "/eventQueue/plugin";
const SERVE_COMMAND = "serve";

const isServe = cds.cli?.command === SERVE_COMMAND;
const isBuild = cds.build?.register;
// NOTE: for sap/cds < 8.2.3 there was no consistent way to detect cds is running as a server, not for build, compile,
//   etc...
const doLegacyBuildDetection =
  cdsPackage.version.localeCompare("8.2.3", undefined, { numeric: true, sensitivity: "base" }) < 0;
if ((doLegacyBuildDetection && isBuild) || (!doLegacyBuildDetection && !isServe)) {
  return;
}

if (Object.keys(cds.env.eventQueue ?? {}).length) {
  module.exports = eventQueue.initialize().catch((err) => {
    if (EventQueueError.isRedisConnectionFailure(err) && eventQueue.config.crashOnRedisUnavailable) {
      throw err;
    }
    cds.log(COMPONENT_NAME).error(err);
  });
}
