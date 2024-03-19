"use strict";

const { AsyncResource } = require("async_hooks");

const cds = require("@sap/cds");

const { processEventQueue } = require("../processEventQueue");
const eventQueueConfig = require("../config");
const WorkerQueue = require("../shared/WorkerQueue");

const COMPONENT_NAME = "/eventQueue/runnerHelper";

const runEventCombinationForTenant = async (context, type, subType, skipWorkerPool) => {
  try {
    if (skipWorkerPool) {
      return await processEventQueue(context, type, subType);
    } else {
      const eventConfig = eventQueueConfig.getEventConfig(type, subType);
      const label = `${type}_${subType}`;
      return await WorkerQueue.instance.addToQueue(
        eventConfig.load,
        label,
        eventConfig.priority,
        AsyncResource.bind(async () => await processEventQueue(context, type, subType))
      );
    }
  } catch (err) {
    const logger = cds.log(COMPONENT_NAME);
    logger.error("error executing event combination for tenant", err, {
      tenantId: context.tenant,
      type,
      subType,
    });
  }
};

module.exports = { runEventCombinationForTenant };
