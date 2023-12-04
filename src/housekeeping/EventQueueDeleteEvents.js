"use strict";

const EventQueueBaseClass = require("../EventQueueProcessorBase");
const config = require("../config");
const eventConfig = require("../config");

const DELETE_PERIOD_EVENTS_AFTER_DAYS = 30;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

class EventQueueDeleteEvents extends EventQueueBaseClass {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  async processPeriodicEvent(processContext, key) {
    const tx = this.getTxForEventProcessing(key);
    const deleteByDaysMapAdhoc = config.events.reduce((result, event) => {
      if (!event.deleteFinishedEventsAfterDays) {
        return result;
      }
      result[event.deleteFinishedEventsAfterDays] ??= [];
      result[event.deleteFinishedEventsAfterDays].push(event);
      return result;
    }, {});

    const deleteByDaysMap = config.periodicEvents.reduce((result, event) => {
      result[DELETE_PERIOD_EVENTS_AFTER_DAYS] ??= [];
      result[DELETE_PERIOD_EVENTS_AFTER_DAYS].push(event);
      return result;
    }, deleteByDaysMapAdhoc);

    for (const [DELETE_AFTER, events] of Object.entries(deleteByDaysMap)) {
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
          { val: new Date(processContext.timestamp.getTime() - DELETE_AFTER * DAY_IN_MS).toISOString() },
        ])
      );
      this.logger.info("deleted eligible events", {
        deleteAfterDays: DELETE_AFTER,
        deleteCount,
        events: events.map((event) => `${event.type}_${event.subType}`),
      });
    }
  }
}

module.exports = EventQueueDeleteEvents;
