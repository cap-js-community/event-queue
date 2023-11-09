"use strict";

const redis = require("./shared/redis");
const { checkLockExistsAndReturnValue } = require("./shared/distributedLock");
const config = require("./config");
const { runEventCombinationForTenant } = require("./runner");

const EVENT_MESSAGE_CHANNEL = "EVENT_QUEUE_MESSAGE_CHANNEL";
const COMPONENT_NAME = "eventQueue/redisPubSub";

let subscriberClientPromise;

const initEventQueueRedisSubscribe = () => {
  if (subscriberClientPromise || !config.getConfigInstance().redisEnabled) {
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
    await runEventCombinationForTenant(tenantId, type, subType);
  } catch (err) {
    logger.error("could not parse event information", {
      messageData,
    });
  }
};

const broadcastEvent = async (tenantId, type, subType) => {
  const logger = cds.log(COMPONENT_NAME);
  const configInstance = config.getConfigInstance();
  if (!configInstance.redisEnabled) {
    if (configInstance.registerAsEventProcessor) {
      await runEventCombinationForTenant(tenantId, type, subType);
    }
    return;
  }
  try {
    const result = await checkLockExistsAndReturnValue(
      new cds.EventContext({ tenant: tenantId }),
      [type, subType].join("##")
    );
    if (result) {
      logger.info("skip publish redis event as no lock is available");
      return;
    }
    logger.debug("publishing redis event", {
      tenantId,
      type,
      subType,
    });
    await redis.publishMessage(EVENT_MESSAGE_CHANNEL, JSON.stringify({ tenantId, type, subType }));
  } catch (err) {
    logger.error(`publish event failed with error: ${err.toString()}`, {
      tenantId,
      type,
      subType,
    });
  }
};

module.exports = {
  initEventQueueRedisSubscribe,
  broadcastEvent,
};
