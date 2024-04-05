"use strict";

const cds = require("@sap/cds");

const redis = require("../shared/redis");
const config = require("../config");
const runnerHelper = require("../runner/runnerHelper");
const common = require("../shared/common");

const EVENT_MESSAGE_CHANNEL = "EVENT_QUEUE_MESSAGE_CHANNEL";
const COMPONENT_NAME = "/eventQueue/redisSub";
let subscriberClientPromise;

const initEventQueueRedisSubscribe = () => {
  if (subscriberClientPromise || !config.redisEnabled) {
    return;
  }
  redis.subscribeRedisChannel(config.redisOptions, EVENT_MESSAGE_CHANNEL, _messageHandlerProcessEvents);
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

    const user = await cds.tx({ tenant: tenantId }, async () => {
      return new cds.User.Privileged({ id: config.userId, authInfo: await common.getAuthInfo(tenantId) });
    });
    const tenantContext = {
      tenant: tenantId,
      user,
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
      return await runnerHelper.runEventCombinationForTenant(context, type, subType);
    });
  } catch (err) {
    logger.error("could not parse event information", {
      messageData,
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
  closeSubscribeClient,
  __: {
    _messageHandlerProcessEvents,
  },
};
