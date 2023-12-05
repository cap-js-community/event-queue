"use strict";

const EventQueueBaseClass = require("../EventQueueProcessorBase");
const config = require("../config");
const eventConfig = require("../config");

const DELETE_DEFAULT_PERIOD_IN_DAYS = 7;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

class EventQueueDeleteEvents extends EventQueueBaseClass {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  async processPeriodicEvent(processContext, key) {
    const tx = this.getTxForEventProcessing(key);
    const deleteByDaysMap = config.events.concat(config.periodicEvents).reduce((result, event) => {
      if (!event.deleteFinishedEventsAfterDays) {
        event.deleteFinishedEventsAfterDays = DELETE_DEFAULT_PERIOD_IN_DAYS;
      }
      result[event.deleteFinishedEventsAfterDays] ??= [];
      result[event.deleteFinishedEventsAfterDays].push(event);
      return result;
    }, {});

    for (const [deleteAfter, events] of Object.entries(deleteByDaysMap)) {
      const deleteCount = await tx.run(
        DELETE.from(eventConfig.tableNameEventQueue).where([
          { list: [{ ref: ["type"] }, { ref: ["subType"] }] },
          "IN",
          {
            list: events.map((event) => ({
              list: [{ val: event.type }, { val: event.subType }],
            })),
          },
          "AND",
          { ref: ["lastAttemptTimestamp"] },
          "<=",
          { val: new Date(processContext.timestamp.getTime() - deleteAfter * DAY_IN_MS).toISOString() },
        ])
      );
      this.logger.info("deleted eligible events", {
        deleteAfterDays: deleteAfter,
        deleteCount,
        events: events.map((event) => `${event.type}_${event.subType}`),
      });
    }
  }
}

module.exports = EventQueueDeleteEvents;
