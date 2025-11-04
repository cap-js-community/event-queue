"use strict";

const { AsyncResource } = require("async_hooks");

const cds = require("@sap/cds");

const { processEventQueue } = require("../processEventQueue");
const eventQueueConfig = require("../config");
const WorkerQueue = require("../shared/WorkerQueue");
const distributedLock = require("../shared/distributedLock");
const { trace } = require("../shared/openTelemetry");

const COMPONENT_NAME = "/eventQueue/runnerHelper";

const runEventCombinationForTenant = async (
  context,
  type,
  subType,
  namespace,
  { skipWorkerPool, lockId, shouldTrace } = {}
) => {
  try {
    if (skipWorkerPool) {
      return await processEventQueue(context, type, subType, namespace);
    } else {
      const eventConfig = eventQueueConfig.getEventConfig(type, subType);
      const label = `${type}_${subType}`;
      return await WorkerQueue.instance.addToQueue(
        eventConfig.load,
        label,
        eventConfig.priority,
        eventConfig.increasePriorityOverTime,
        AsyncResource.bind(async () => {
          const _exec = async () => {
            if (!eventConfig.multiInstanceProcessing && lockId) {
              const lockAvailable = await distributedLock.acquireLock(context, lockId);
              if (!lockAvailable) {
                return;
              }
            }

            await processEventQueue(context, type, subType, namespace);
          };
          if (shouldTrace) {
            return await trace(context, label, _exec, { newRootSpan: true });
          } else {
            return await _exec();
          }
        })
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
