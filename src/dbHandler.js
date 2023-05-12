"use strict";

const { publishEvent } = require("./redisPubSub");

const registerEventQueueDbHandler = (dbService) => {
  const def = dbService.model.definitions["sap.eventQueue.EventQueue"];
  dbService.after("CREATE", def, (_, req) => {
    req.tx._ = req.tx._ ?? {};
    req.tx._.afc = req.tx._.afc ?? {};
    req.tx._.afc.eventQueuePublishEvents =
      req.tx._.afc.eventQueuePublishEvents ?? {};
    const eventQueuePublishEvents = req.tx._.afc.eventQueuePublishEvents;
    const data = Array.isArray(req.data) ? req.data : [req.data];
    const eventCombinations = Object.keys(
      data.reduce((result, event) => {
        const key = [event.type, event.subType].join("##");
        if (eventQueuePublishEvents[key]) {
          return result;
        }
        eventQueuePublishEvents[key] = true;
        result[key] = true;
        return result;
      }, {})
    );

    eventCombinations.length &&
      req.on("succeeded", () => {
        for (const eventCombination of eventCombinations) {
          publishEvent(req.tenant, ...eventCombination.split("##"));
        }
      });
  });
};

module.exports = {
  registerEventQueueDbHandler,
};
