"use strict";

const config = require("./config");
const common = require("./shared/common");
const EventQueueError = require("./EventQueueError");
const { processChunkedSync } = require("./shared/common");

const CHUNK_SIZE_INSERTS = 3000;

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

  if (config.insertEventsBeforeCommit) {
    _registerHandlerAndAddEvents(tx, events);
  } else {
    tx._skipEventQueueBroadcase = skipBroadcast;
    const chunks = [];
    processChunkedSync(eventsForProcessing, CHUNK_SIZE_INSERTS, (chunk) => chunks.push(chunk));
    let result;
    for (const chunk of chunks) {
      if (result) {
        await tx.run(INSERT.into(config.tableNameEventQueue).entries(chunk));
      }
      result = await tx.run(INSERT.into(config.tableNameEventQueue).entries(chunk));
    }
    tx._skipEventQueueBroadcase = false;
    return result;
  }
};

const _registerHandlerAndAddEvents = (tx, events) => {
  tx._eventQueue ??= { events: [], handlerRegistered: false };
  tx._eventQueue.events = tx._eventQueue.events.concat(events);

  if (tx._eventQueue.handlerRegistered) {
    return;
  }
  tx._eventQueue.handlerRegistered = true;
  tx.context.before("commit", async () => {
    if (!tx._eventQueue.events?.length) {
      return;
    }
    const chunks = [];
    processChunkedSync(tx._eventQueue.events, CHUNK_SIZE_INSERTS, (chunk) => chunks.push(chunk));
    for (const chunk of chunks) {
      await tx.run(INSERT.into(config.tableNameEventQueue).entries(chunk));
    }
    tx._eventQueue = null;
  });
};

module.exports = {
  publishEvent,
};
