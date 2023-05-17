"use strict";

const redisWrapper = require("@sap/btp-feature-toggles/src/redisWrapper");

const { processEventQueue } = require("./processEventQueue");
const { Logger } = require("./shared/logger");
const { getSubdomainForTenantId } = require("./shared/cdsHelper");
const { checkLockExistsAndReturnValue } = require("./shared/distributedLock");
const { isOnCF } = require("./shared/env");
const config = require("./config");

const MESSAGE_CHANNEL = "cdsEventQueue";
const COMPONENT_NAME = "/eventQueue/redisPubSub";

let publishClient;
let subscriberClientPromise;

const initEventQueueRedisSubscribe = () => {
  if (!subscriberClientPromise) {
    subscribeRedisClient();
  }
};

const subscribeRedisClient = () => {
  const errorHandlerCreateClient = (err) => {
    Logger(cds.context, COMPONENT_NAME).error(
      "error from redis client for pub/sub failed",
      { error: err }
    );
    subscriberClientPromise = null;
    setTimeout(subscribeRedisClient, 5 * 1000);
  };
  subscriberClientPromise = redisWrapper._._createClientAndConnect(
    errorHandlerCreateClient
  );
  subscriberClientPromise
    .then((client) => {
      Logger(cds.context, COMPONENT_NAME).info(
        "subscribe redis client connected"
      );
      client.subscribe(MESSAGE_CHANNEL, messageHandlerProcessEvents);
    })
    .catch((err) => {
      Logger(cds.context, COMPONENT_NAME).error(
        "error from redis client for pub/sub failed during startup - trying to reconnect",
        { error: err }
      );
    });
};

const messageHandlerProcessEvents = async (messageData) => {
  let tenantId, type, subType;
  try {
    ({ tenantId, type, subType } = JSON.parse(messageData));
  } catch (err) {
    Logger(cds.context, COMPONENT_NAME).error(
      "could not parse event information",
      {
        additionalMessageProperties: messageData,
      }
    );
    return;
  }
  const subdomain = await getSubdomainForTenantId(tenantId);
  const context = new cds.EventContext({
    tenant: tenantId,
    // NOTE: we need this because of logging otherwise logs would not contain the subdomain
    http: { req: { authInfo: { getSubdomain: () => subdomain } } },
  });
  cds.context = context;
  Logger(context, COMPONENT_NAME).debug("received redis event", {
    additionalMessageProperties: {
      tenantId,
      type,
      subType,
    },
  });
  processEventQueue(context, type, subType);
};

const publishEvent = async (tenantId, type, subType) => {
  const configInstance = config.getConfigInstance();
  if (!isOnCF || !configInstance.redisEnabled) {
    await _handleEventInternally(tenantId, type, subType);
    return;
  }

  const logger = Logger(cds.context, COMPONENT_NAME);
  const errorHandlerCreateClient = (err) => {
    logger.error("error from redis client for pub/sub failed", {
      error: err,
    });
    publishClient = null;
  };
  try {
    if (!publishClient) {
      publishClient = await redisWrapper._._createClientAndConnect(
        errorHandlerCreateClient
      );
      logger.info("publish redis client connected");
    }

    const result = await checkLockExistsAndReturnValue(
      new cds.EventContext({ tenant: tenantId }),
      [type, subType].join("##")
    );
    if (result) {
      logger.info("skip publish redis event as no lock is available");
      return;
    }
    logger.debug("publishing redis event", {
      additionalMessageProperties: { tenantId, type, subType },
    });
    await publishClient.publish(
      MESSAGE_CHANNEL,
      JSON.stringify({ tenantId, type, subType })
    );
  } catch (err) {
    logger.error("publish event failed", {
      additionalMessageProperties: { tenantId, type, subType },
      error: err,
    });
  }
};

const _handleEventInternally = async (tenantId, type, subType) => {
  const logger = Logger(cds.context, COMPONENT_NAME);
  logger.info("processEventQueue internally", {
    additionalMessageProperties: {
      tenantId,
      type,
      subType,
    },
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
