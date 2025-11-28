"use strict";

const cds = require("@sap/cds");

const redisPub = require("./redis/redisPub");
const config = require("./config");

const COMPONENT_NAME = "/eventQueue/dbHandler";
const registeredHandlers = {
  eventQueueDbHandler: false,
  beforeDbHandler: false,
};

const registerEventQueueDbHandler = (dbService) => {
  if (registeredHandlers.eventQueueDbHandler) {
    return;
  }

  registeredHandlers.eventQueueDbHandler = true;
  const def = dbService.model.definitions[config.tableNameEventQueue];
  dbService.after("CREATE", def, (_, req) => {
    if (req.tx._skipEventQueueBroadcast) {
      return;
    }
    req.tx._ = req.tx._ ?? {};
    req.tx._.eventQueuePublishEvents = req.tx._.eventQueuePublishEvents ?? {};
    const eventQueuePublishEvents = req.tx._.eventQueuePublishEvents;
    const data = Array.isArray(req.query.INSERT.entries) ? req.query.INSERT.entries : [req.query.INSERT.entries];
    const eventCombinations = Object.keys(
      data.reduce((result, event) => {
        const key = [event.type, event.subType, event.namespace].join("##");
        if (
          !config.hasEventAfterCommitFlag(event.type, event.subType, event.namespace) ||
          eventQueuePublishEvents[key]
        ) {
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
          const [type, subType, namespace] = eventCombination.split("##");
          return { type, subType, namespace };
        });

        redisPub.broadcastEvent(req.tenant, events).catch((err) => {
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
