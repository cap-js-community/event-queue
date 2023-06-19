"use strict";

const config = require("./config");
const EventQueueError = require("./EventQueueError");

const publishEvent = async (tx, events) => {
  const configInstance = config.getConfigInstance();
  if (!configInstance.initialized) {
    throw EventQueueError.notInitialized();
  }
  const eventsForProcessing = Array.isArray(events) ? events : [events];
  for (const { type, subType } of eventsForProcessing) {
    const eventConfig = configInstance.getEventConfig(type, subType);
    if (!eventConfig) {
      throw EventQueueError.unknownEventType(type, subType);
    }
  }
  await tx.run(
    INSERT.into(configInstance.tableNameEventQueue).entries(eventsForProcessing)
  );
};

module.exports = {
  publishEvent,
};
