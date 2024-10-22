"use strict";

const { promisify } = require("util");

const cds = require("@sap/cds");

const redis = require("../shared/redis");
const { checkLockExistsAndReturnValue } = require("../shared/distributedLock");
const config = require("../config");
const common = require("../shared/common");
const { runEventCombinationForTenant } = require("../runner/runnerHelper");
const trace = require("../shared/openTelemetry");

const EVENT_MESSAGE_CHANNEL = "EVENT_QUEUE_MESSAGE_CHANNEL";
const COMPONENT_NAME = "/eventQueue/redisPub";
const TRIES_FOR_PUBLISH_PERIODIC_EVENT = 10;
const SLEEP_TIME_FOR_PUBLISH_PERIODIC_EVENT = 30 * 1000;

const wait = promisify(setTimeout);

const broadcastEvent = async (tenantId, events, forceBroadcast = false) => {
  const logger = cds.log(COMPONENT_NAME);

  if (!config.isEventQueueActive) {
    cds.log(COMPONENT_NAME).info("event-queue is deactivated, broadcasting is skipped!");
    return;
  }

  events = Array.isArray(events) ? events : [events];
  try {
    if (!config.redisEnabled) {
      await _processLocalWithoutRedis(tenantId, events);
      return;
    }
    await cds.tx({ tenant: tenantId }, async ({ context }) => {
      await trace(context, "broadcast-inserted-events", async () => {
        for (const { type, subType } of events) {
          const eventConfig = config.getEventConfig(type, subType);
          for (let i = 0; i < TRIES_FOR_PUBLISH_PERIODIC_EVENT; i++) {
            const result = await checkLockExistsAndReturnValue(context, [type, subType].join("##"));
            if (result) {
              logger.debug("skip publish redis event as no lock is available", {
                type,
                subType,
                index: i,
                isPeriodic: eventConfig.isPeriodic,
                waitInterval: SLEEP_TIME_FOR_PUBLISH_PERIODIC_EVENT,
              });
              if (!eventConfig.isPeriodic && !forceBroadcast) {
                break;
              }
              await wait(SLEEP_TIME_FOR_PUBLISH_PERIODIC_EVENT);
              continue;
            }
            logger.debug("publishing redis event", {
              tenantId,
              type,
              subType,
            });
            await redis.publishMessage(
              config.redisOptions,
              EVENT_MESSAGE_CHANNEL,
              JSON.stringify({ lockId: cds.utils.uuid(), tenantId, type, subType })
            );
            break;
          }
        }
      });
    });
  } catch (err) {
    logger.error("publish events failed!", err, {
      tenantId,
    });
  }
};

const _processLocalWithoutRedis = async (tenantId, events) => {
  if (config.registerAsEventProcessor) {
    let context = {};
    if (tenantId) {
      const user = await cds.tx({ tenant: tenantId }, async () => {
        return new cds.User.Privileged({ id: config.userId, authInfo: await common.getAuthInfo(tenantId) });
      });
      context = {
        tenant: tenantId,
        user,
      };
    }

    for (const { type, subType } of events) {
      await cds.tx(context, async ({ context }) => {
        await runEventCombinationForTenant(context, type, subType, { shouldTrace: true });
      });
    }
  }
};

module.exports = {
  broadcastEvent,
};
