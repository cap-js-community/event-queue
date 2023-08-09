"use strict";

const redis = require("./shared/redis");
const { processEventQueue } = require("./processEventQueue");
const { getSubdomainForTenantId } = require("./shared/cdsHelper");
const { checkLockExistsAndReturnValue } = require("./shared/distributedLock");
const config = require("./config");
const { getWorkerPoolInstance } = require("./shared/WorkerQueue");

const EVENT_MESSAGE_CHANNEL = "EVENT_QUEUE_MESSAGE_CHANNEL";
const COMPONENT_NAME = "eventQueue/redisPubSub";
const LOGGER = cds.log(COMPONENT_NAME);

let subscriberClientPromise;

const initEventQueueRedisSubscribe = () => {
  if (subscriberClientPromise || !config.getConfigInstance().redisEnabled) {
    return;
  }
  redis.subscribeRedisChannel(EVENT_MESSAGE_CHANNEL, messageHandlerProcessEvents);
};

const messageHandlerProcessEvents = async (messageData) => {
  try {
    const { tenantId, type, subType } = JSON.parse(messageData);
    const subdomain = await getSubdomainForTenantId(tenantId);
    const context = new cds.EventContext({
      tenant: tenantId,
      // NOTE: we need this because of logging otherwise logs would not contain the subdomain
      http: { req: { authInfo: { getSubdomain: () => subdomain } } },
    });
    cds.context = context;
    LOGGER.debug("received redis event", {
      tenantId,
      type,
      subType,
    });
    getWorkerPoolInstance().addToQueue(async () => processEventQueue(context, type, subType));
  } catch (err) {
    LOGGER.error("could not parse event information", {
      messageData,
    });
  }
};

const publishEvent = async (tenantId, type, subType) => {
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
      LOGGER.info("skip publish redis event as no lock is available");
      return;
    }
    LOGGER.debug("publishing redis event", {
      tenantId,
      type,
      subType,
    });
    await redis.publishMessage(EVENT_MESSAGE_CHANNEL, JSON.stringify({ tenantId, type, subType }));
  } catch (err) {
    LOGGER.error(`publish event failed with error: ${err.toString()}`, {
      tenantId,
      type,
      subType,
    });
  }
};

const _handleEventInternally = async (tenantId, type, subType) => {
  LOGGER.info("processEventQueue internally", {
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
  processEventQueue(context, type, subType);
};

module.exports = {
  initEventQueueRedisSubscribe,
  publishEvent,
};
