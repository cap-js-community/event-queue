"use strict";

const redis = require("./shared/redis");
const { processEventQueue } = require("./processEventQueue");
const { getSubdomainForTenantId } = require("./shared/cdsHelper");
const { checkLockExistsAndReturnValue } = require("./shared/distributedLock");
const config = require("./config");
const { getWorkerPoolInstance } = require("./shared/WorkerQueue");

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
    const subdomain = await getSubdomainForTenantId(tenantId);
    const context = new cds.EventContext({
      tenant: tenantId,
      // NOTE: we need this because of logging otherwise logs would not contain the subdomain
      http: { req: { authInfo: { getSubdomain: () => subdomain } } },
    });
    cds.context = context;
    logger.debug("received redis event", {
      tenantId,
      type,
      subType,
    });
    getWorkerPoolInstance().addToQueue(async () => processEventQueue(context, type, subType));
  } catch (err) {
    logger.error("could not parse event information", {
      messageData,
    });
  }
};

const publishEvent = async (tenantId, type, subType) => {
  const logger = cds.log(COMPONENT_NAME);
  const configInstance = config.getConfigInstance();
  if (!configInstance.redisEnabled) {
    await _handleEventInternally(tenantId, type, subType);
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

const _handleEventInternally = async (tenantId, type, subType) => {
  cds.log(COMPONENT_NAME).info("processEventQueue internally", {
    tenantId,
    type,
    subType,
  });
  const subdomain = await getSubdomainForTenantId(tenantId);
  const context = new cds.EventContext({
    tenant: tenantId,
    // NOTE: we need this because of logging otherwise logs would not contain the subdomain
    http: { req: { authInfo: { getSubdomain: () => subdomain } } },
  });
  getWorkerPoolInstance().addToQueue(async () => processEventQueue(context, type, subType));
};

module.exports = {
  initEventQueueRedisSubscribe,
  publishEvent,
};
