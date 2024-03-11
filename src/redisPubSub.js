"use strict";

const { promisify } = require("util");

const cds = require("@sap/cds");

const redis = require("./shared/redis");
const { checkLockExistsAndReturnValue } = require("./shared/distributedLock");
const config = require("./config");
const runner = require("./runner");
const { getSubdomainForTenantId } = require("./shared/cdsHelper");

const EVENT_MESSAGE_CHANNEL = "EVENT_QUEUE_MESSAGE_CHANNEL";
const COMPONENT_NAME = "/eventQueue/redisPubSub";
const TRIES_FOR_PUBLISH_PERIODIC_EVENT = 10;
const SLEEP_TIME_FOR_PUBLISH_PERIODIC_EVENT = 30 * 1000;

const wait = promisify(setTimeout);
let subscriberClientPromise;

const initEventQueueRedisSubscribe = () => {
  if (subscriberClientPromise || !config.redisEnabled) {
    return;
  }
  redis.subscribeRedisChannel(EVENT_MESSAGE_CHANNEL, _messageHandlerProcessEvents);
};

const _messageHandlerProcessEvents = async (messageData) => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    const { tenantId, type, subType } = JSON.parse(messageData);
    logger.debug("received redis event", {
      tenantId,
      type,
      subType,
    });
    if (!config.isEventQueueActive) {
      cds.log(COMPONENT_NAME).info("Skipping processing because runner is deactivated!", {
        type,
        subType,
      });
      return;
    }

    const subdomain = await getSubdomainForTenantId(tenantId);
    const user = new cds.User.Privileged(config.userId);
    const tenantContext = {
      tenant: tenantId,
      user,
      // NOTE: we need this because of logging otherwise logs would not contain the subdomain
      http: { req: { authInfo: { getSubdomain: () => subdomain } } },
    };

    if (!config.getEventConfig(type, subType)) {
      if (config.isCapOutboxEvent(type)) {
        try {
          const service = await cds.connect.to(subType);
          cds.outboxed(service);
        } catch (err) {
          logger.error("could not connect to outboxed service", err, {
            type,
            subType,
          });
          return;
        }
      } else {
        logger.error("cannot find configuration for published event. Event won't be processed", {
          type,
          subType,
        });
        return;
      }
    }

    return await cds.tx(tenantContext, async ({ context }) => {
      return await runner.runEventCombinationForTenant(context, type, subType);
    });
  } catch (err) {
    logger.error("could not parse event information", {
      messageData,
    });
  }
};

const broadcastEvent = async (tenantId, type, subType) => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    if (!config.isEventQueueActive) {
      cds.log(COMPONENT_NAME).info("Skipping processing because runner is deactivated!", {
        type,
        subType,
      });
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
          return await runner.runEventCombinationForTenant(context, type, subType);
        });
      }
      return;
    }
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
  } catch (err) {
    logger.error("publish event failed!", err, {
      tenantId,
      type,
      subType,
    });
  }
};

const closeSubscribeClient = async () => {
  try {
    const client = await subscriberClientPromise;
    if (client?.quit) {
      await client.quit();
    }
  } catch (err) {
    // ignore errors during shutdown
  }
};

module.exports = {
  initEventQueueRedisSubscribe,
  broadcastEvent,
  closeSubscribeClient,
  __: {
    _messageHandlerProcessEvents,
  },
};
