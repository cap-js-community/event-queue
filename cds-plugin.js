"use strict";

const cds = require("@sap/cds");
const cdsPackage = require("@sap/cds/package.json");

const eventQueue = require("./src");

const activate = async () => {
  const eventQueueConfig = cds.env.eventQueue;
  if (!eventQueueConfig?.config && !eventQueueConfig?.configFilePath) {
    return;
  }

  await eventQueue.initialize();
};

// NOTE: for sap/cds < 7.3.0 it was expected to export activate as function property, otherwise export the promise of
//   running activate
const doExportActivateAsProperty =
  cdsPackage.version.localeCompare("7.3.0", undefined, { numeric: true, sensitivity: "base" }) < 0;

module.exports = doExportActivateAsProperty
  ? {
      activate,
    }
  : activate();
