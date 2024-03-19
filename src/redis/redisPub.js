"use strict";

const { promisify } = require("util");

const cds = require("@sap/cds");

const redis = require("../shared/redis");
const { checkLockExistsAndReturnValue } = require("../shared/distributedLock");
const config = require("../config");
const { getSubdomainForTenantId } = require("../shared/cdsHelper");
const { runEventCombinationForTenant } = require("../runner/runnerHelper");

const EVENT_MESSAGE_CHANNEL = "EVENT_QUEUE_MESSAGE_CHANNEL";
const COMPONENT_NAME = "/eventQueue/redisPub";
const TRIES_FOR_PUBLISH_PERIODIC_EVENT = 10;
const SLEEP_TIME_FOR_PUBLISH_PERIODIC_EVENT = 30 * 1000;

const wait = promisify(setTimeout);

const broadcastEvent = async (tenantId, events) => {
  const logger = cds.log(COMPONENT_NAME);
  events = Array.isArray(events) ? events : [events];
  try {
    if (!config.isEventQueueActive) {
      cds.log(COMPONENT_NAME).info("Skipping processing because runner is deactivated!", {});
      return;
    }
    if (!config.redisEnabled) {
      if (config.registerAsEventProcessor) {
        let context = {};
        if (tenantId) {
          const subdomain = await getSubdomainForTenantId(tenantId);
          const user = new cds.User.Privileged(config.userId);
          context = {
            // NOTE: we need this because of logging otherwise logs would not contain the subdomain
            tenant: tenantId,
            user,
            http: { req: { authInfo: { getSubdomain: () => subdomain } } },
          };
        }

        return await cds.tx(context, async ({ context }) => {
          for (const { type, subType } of events) {
            await runEventCombinationForTenant(context, type, subType);
          }
        });
      }
      return;
    }
    for (const { type, subType } of events) {
      const eventConfig = config.getEventConfig(type, subType);
      for (let i = 0; i < TRIES_FOR_PUBLISH_PERIODIC_EVENT; i++) {
        const result = await checkLockExistsAndReturnValue(
          new cds.EventContext({ tenant: tenantId }),
          [type, subType].join("##")
        );
        if (result) {
          logger.debug("skip publish redis event as no lock is available", {
            type,
            subType,
            index: i,
            isPeriodic: eventConfig.isPeriodic,
            waitInterval: SLEEP_TIME_FOR_PUBLISH_PERIODIC_EVENT,
          });
          if (!eventConfig.isPeriodic) {
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
        await redis.publishMessage(EVENT_MESSAGE_CHANNEL, JSON.stringify({ tenantId, type, subType }));
        break;
      }
    }
  } catch (err) {
    logger.error("publish events failed!", err, {
      tenantId,
    });
  }
};

module.exports = {
  broadcastEvent,
};
