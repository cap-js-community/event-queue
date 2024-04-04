"use strict";

const cds = require("@sap/cds");

const { broadcastEvent } = require("./redis/redisPub");
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

const registerBeforeDbHandler = (dbService) => {
  if (!config.insertEventsBeforeCommit || registeredHandlers.beforeDbHandler) {
    return;
  }

  registeredHandlers.beforeDbHandler = true;
  dbService.before("COMMIT", async (req) => {
    if (req.context._eventQueueEvents?.length) {
      await cds.tx(req).run(INSERT.into(config.tableNameEventQueue).entries(req.context._eventQueueEvents));
      req.context._eventQueueEvents = null;
    }
  });
};

module.exports = {
  registerEventQueueDbHandler,
  registerBeforeDbHandler,
};
