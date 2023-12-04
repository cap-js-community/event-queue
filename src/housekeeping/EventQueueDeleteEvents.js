"use strict";

const EventQueueBaseClass = require("../EventQueueProcessorBase");
const config = require("../config");

class EventQueueDeleteEvents extends EventQueueBaseClass {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  async processPeriodicEvent(processContext, key) {
    const tx = this.getTxForEventProcessing(key);
    const deleteByDaysMap = config.events.reduce((result, event) => {
      if (!event.deleteFinishedEventsAfterDays) {
        return result;
      }
      result[event.deleteFinishedEventsAfterDays] ??= [];
      result[event.deleteFinishedEventsAfterDays].push(event);
      return result;
    }, {});

    for (const [key, events] of Object.entries(deleteByDaysMap)) {
      debugger;
    }

    //
  }
}

module.exports = EventQueueDeleteEvents;
