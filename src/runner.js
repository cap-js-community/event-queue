"use strict";

const eventQueueConfig = require("./config");

const singleInstanceRunner = () => {
  const configInstance = eventQueueConfig.getConfigInstance();
  const eventsForAutomaticRun = configInstance.getEventsForAutomaticRuns;
};
