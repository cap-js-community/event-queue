"use strict";

const config = require("./config");
const common = require("./shared/common");
const EventQueueError = require("./EventQueueError");

/**
 * Asynchronously publishes a series of events to the event queue.
 *
 * @param {Transaction} tx - The transaction object to be used for database operations.
 * @param {Array|Object} events - An array of event objects or a single event object. Each event object should match the Event table structure:
 *   {
 *     type: String, // Event type. This is a required field.
 *     subType: String, // Event subtype. This is a required field.
 *     referenceEntity: String, // Reference entity associated with the event.
 *     referenceEntityKey: UUID, // UUID key of the reference entity.
 *     status: Status, // Status of the event, defaults to 0.
 *     payload: LargeString, // Payload of the event.
 *     attempts: Integer, // The number of attempts made, defaults to 0.
 *     lastAttemptTimestamp: Timestamp, // Timestamp of the last attempt.
 *     createdAt: Timestamp, // Timestamp of event creation. This field is automatically set on insert.
 *     startAfter: Timestamp, // Timestamp indicating when the event should start after.
 *   }
 * @param {Boolean} skipBroadcast - (Optional) If set to true, event broadcasting will be skipped. Defaults to false.
 * @throws {EventQueueError} Throws an error if the configuration is not initialized.
 * @throws {EventQueueError} Throws an error if the event type is unknown.
 * @throws {EventQueueError} Throws an error if the startAfter field is not a valid date.
 * @returns {Promise} Returns a promise which resolves to the result of the database insert operation.
 */
const publishEvent = async (tx, events, skipBroadcast = false) => {
  if (!config.initialized) {
    throw EventQueueError.notInitialized();
  }
  const eventsForProcessing = Array.isArray(events) ? events : [events];
  for (const { type, subType, startAfter } of eventsForProcessing) {
    const eventConfig = config.getEventConfig(type, subType);
    if (!eventConfig) {
      throw EventQueueError.unknownEventType(type, subType);
    }
    if (startAfter && !common.isValidDate(startAfter)) {
      throw EventQueueError.malformedDate(startAfter);
    }

    if (eventConfig.isPeriodic) {
      throw EventQueueError.manuelPeriodicEventInsert(type, subType);
    }
  }
  tx._skipEventQueueBroadcase = skipBroadcast;
  const result = await tx.run(INSERT.into(config.tableNameEventQueue).entries(eventsForProcessing));
  tx._skipEventQueueBroadcase = false;
  return result;
};

module.exports = {
  publishEvent,
};
