"use strict";

const cds = require("@sap/cds");

const { broadcastEvent } = require("./redis/redisPub");
const config = require("./config");

const COMPONENT_NAME = "/eventQueue/dbHandler";

const registerEventQueueDbHandler = (dbService) => {
  const def = dbService.model.definitions[config.tableNameEventQueue];
  dbService.after("CREATE", def, (_, req) => {
    if (req.tx._skipEventQueueBroadcase) {
      return;
    }
    req.tx._ = req.tx._ ?? {};
    req.tx._.eventQueuePublishEvents = req.tx._.eventQueuePublishEvents ?? {};
    const eventQueuePublishEvents = req.tx._.eventQueuePublishEvents;
    const data = Array.isArray(req.data) ? req.data : [req.data];
    const eventCombinations = Object.keys(
      data.reduce((result, event) => {
        const key = [event.type, event.subType].join("##");
        if (!config.hasEventAfterCommitFlag(event.type, event.subType) || eventQueuePublishEvents[key]) {
          return result;
        }
        eventQueuePublishEvents[key] = true;
        result[key] = true;
        return result;
      }, {})
    );

    eventCombinations.length &&
      req.on("succeeded", () => {
        const events = eventCombinations.map((eventCombination) => {
          const [type, subType] = eventCombination.split("##");
          return { type, subType };
        });

        broadcastEvent(req.tenant, events).catch((err) => {
          cds.log(COMPONENT_NAME).error("db handler failure during broadcasting event", err, {
            tenant: req.tenant,
            events,
          });
        });
      });
  });
};

module.exports = {
  registerEventQueueDbHandler,
};
