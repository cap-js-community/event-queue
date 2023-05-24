"use strict";

const redisWrapper = require("@sap/btp-feature-toggles/src/redisWrapper");

const { processEventQueue } = require("./processEventQueue");
const { getSubdomainForTenantId } = require("./shared/cdsHelper");
const { checkLockExistsAndReturnValue } = require("./shared/distributedLock");
const config = require("./config");
const { getWorkerPoolInstance } = require("./shared/WorkerQueue");

const MESSAGE_CHANNEL = "cdsEventQueue";
const COMPONENT_NAME = "eventQueue/redisPubSub";

let publishClient;
let subscriberClientPromise;

const initEventQueueRedisSubscribe = () => {
  if (subscriberClientPromise || !config.getConfigInstance().redisEnabled) {
    return;
  }
  subscribeRedisClient();
};

const subscribeRedisClient = () => {
  const errorHandlerCreateClient = (err) => {
    cds
      .log(COMPONENT_NAME)
      .error("error from redis client for pub/sub failed", err);
    subscriberClientPromise = null;
    setTimeout(subscribeRedisClient, 5 * 1000);
  };
  subscriberClientPromise = redisWrapper._._createClientAndConnect(
    errorHandlerCreateClient
  );
  subscriberClientPromise
    .then((client) => {
      cds.log(COMPONENT_NAME).info("subscribe redis client connected");
      client.subscribe(MESSAGE_CHANNEL, messageHandlerProcessEvents);
    })
    .catch((err) => {
      cds
        .log(COMPONENT_NAME)
        .error(
          "error from redis client for pub/sub failed during startup - trying to reconnect",
          err
        );
    });
};

const messageHandlerProcessEvents = async (messageData) => {
  let tenantId, type, subType;
  try {
    ({ tenantId, type, subType } = JSON.parse(messageData));
  } catch (err) {
    cds.log(COMPONENT_NAME).error("could not parse event information", {
      messageData,
    });
    return;
  }
  const subdomain = await getSubdomainForTenantId(tenantId);
  const context = new cds.EventContext({
    tenant: tenantId,
    // NOTE: we need this because of logging otherwise logs would not contain the subdomain
    http: { req: { authInfo: { getSubdomain: () => subdomain } } },
  });
  cds.context = context;
  cds.log(COMPONENT_NAME).debug("received redis event", {
    tenantId,
    type,
    subType,
  });
  getWorkerPoolInstance().addToQueue(async () =>
    processEventQueue(context, type, subType)
  );
};

const publishEvent = async (tenantId, type, subType) => {
  const configInstance = config.getConfigInstance();
  if (!configInstance.redisEnabled) {
    await _handleEventInternally(tenantId, type, subType);
    return;
  }

  const logger = cds.log(COMPONENT_NAME);
  const errorHandlerCreateClient = (err) => {
    logger.error("error from redis client for pub/sub failed", {
      err,
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
      tenantId,
      type,
      subType,
    });
    await publishClient.publish(
      MESSAGE_CHANNEL,
      JSON.stringify({ tenantId, type, subType })
    );
  } catch (err) {
    logger.error(`publish event failed with error: ${err.toString()}`, {
      tenantId,
      type,
      subType,
    });
  }
};

const _handleEventInternally = async (tenantId, type, subType) => {
  const logger = cds.log(COMPONENT_NAME);
  logger.info("processEventQueue internally", {
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
