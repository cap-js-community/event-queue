"use strict";

const cds = require("@sap/cds");

const redis = require("./shared/redis");
const { checkLockExistsAndReturnValue } = require("./shared/distributedLock");
const config = require("./config");
const { runEventCombinationForTenant } = require("./runner");
const { getSubdomainForTenantId } = require("./shared/cdsHelper");

const EVENT_MESSAGE_CHANNEL = "EVENT_QUEUE_MESSAGE_CHANNEL";
const COMPONENT_NAME = "eventQueue/redisPubSub";

let subscriberClientPromise;

const initEventQueueRedisSubscribe = () => {
  if (subscriberClientPromise || !config.redisEnabled) {
    return;
  }
  redis.subscribeRedisChannel(EVENT_MESSAGE_CHANNEL, messageHandlerProcessEvents);
};

const messageHandlerProcessEvents = async (messageData) => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    const { tenantId, type, subType } = JSON.parse(messageData);
    logger.debug("received redis event", {
      tenantId,
      type,
      subType,
    });
    if (config.isRunnerDeactivated) {
      cds.log(COMPONENT_NAME).info("Skipping processing because runner is deactivated!", {
        type,
        subType,
      });
      return;
    }

    const subdomain = await getSubdomainForTenantId(tenantId);
    const tenantContext = {
      tenant: tenantId,
      // NOTE: we need this because of logging otherwise logs would not contain the subdomain
      http: { req: { authInfo: { getSubdomain: () => subdomain } } },
    };
    return await cds.tx(tenantContext, async ({ context }) => {
      return await runEventCombinationForTenant(context, type, subType);
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
    if (config.isRunnerDeactivated) {
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
          context = {
            // NOTE: we need this because of logging otherwise logs would not contain the subdomain
            tenant: tenantId,
            http: { req: { authInfo: { getSubdomain: () => subdomain } } },
          };
        }

        return await cds.tx(context, async ({ context }) => {
          return await runEventCombinationForTenant(context, type, subType);
        });
      }
      return;
    }
    const result = await checkLockExistsAndReturnValue(
      new cds.EventContext({ tenant: tenantId }),
      [type, subType].join("##")
    );
    if (result) {
      logger.info("skip publish redis event as no lock is available", {
        type,
        subType,
      });
      return;
    }
    logger.debug("publishing redis event", {
      tenantId,
      type,
      subType,
    });
    await redis.publishMessage(EVENT_MESSAGE_CHANNEL, JSON.stringify({ tenantId, type, subType }));
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
};
