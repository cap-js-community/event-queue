"use strict";

const cds = require("@sap/cds");

const redis = require("../shared/redis");
const config = require("../config");
const runnerHelper = require("../runner/runnerHelper");
const common = require("../shared/common");
const { TenantIdCheckTypes } = require("../constants");

const EVENT_MESSAGE_CHANNEL = "EVENT_QUEUE_MESSAGE_CHANNEL";
const COMPONENT_NAME = "/eventQueue/redisSub";

const initEventQueueRedisSubscribe = () => {
  if (initEventQueueRedisSubscribe._initDone || !config.redisEnabled) {
    return;
  }
  initEventQueueRedisSubscribe._initDone = true;

  const namespaces = [config.processingNamespaces];
  if (config.processDefaultNamespace) {
    namespaces.push("");
  }

  namespaces.forEach((namespace) => {
    redis.subscribeRedisChannel(
      [namespace, EVENT_MESSAGE_CHANNEL].join("_"),
      _messageHandlerProcessEvents
    );
  });
};

const _messageHandlerProcessEvents = async (messageData) => {
  const logger = cds.log(COMPONENT_NAME);
  try {
    const { lockId, tenantId, type, subType, namespace } = JSON.parse(messageData);
    const tenantShouldBeProcessed = await common.isTenantIdValidCb(TenantIdCheckTypes.eventProcessing, tenantId);
    if (!tenantShouldBeProcessed) {
      return;
    }
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

    const [serviceNameOrSubType, actionName] = subType.split(".");
    if (!config.getEventConfig(type, subType)) {
      if (config.isCapOutboxEvent(type)) {
        try {
          const service = await cds.connect.to(serviceNameOrSubType);
          cds.outboxed(service);
          if (actionName) {
            const specificSettings = config.getCdsOutboxEventSpecificConfig(serviceNameOrSubType, actionName);
            if (specificSettings) {
              config.addCAPOutboxEventSpecificAction(serviceNameOrSubType, actionName);
            }
          }
        } catch (err) {
          logger.warn("could not connect to outboxed service", err, {
            type,
            subType,
          });
          return;
        }
      } else {
        logger.warn("cannot find configuration for published event. Event won't be processed", {
          type,
          subType,
        });
        return;
      }
    }

    if (!(config.getEventConfig(type, subType) && config.shouldBeProcessedInThisApplication(type, subType))) {
      logger.debug("event is not configured to be processed on this app-name", {
        tenantId,
        type,
        subType,
      });
      return;
    }

    const user = await cds.tx({ tenant: tenantId }, async () => {
      const authInfo = await common.getAuthContext(tenantId);
      return new cds.User.Privileged({ id: config.userId, authInfo, tokenInfo: authInfo?.token });
    });
    const tenantContext = {
      tenant: tenantId,
      user,
    };

    return await cds.tx(tenantContext, async ({ context }) => {
      return await runnerHelper.runEventCombinationForTenant(context, type, subType, namespace, {
        lockId,
        shouldTrace: true,
      });
    });
  } catch (err) {
    logger.error("could not parse event information", {
      messageData,
    });
  }
};

module.exports = {
  initEventQueueRedisSubscribe,
  __: {
    _messageHandlerProcessEvents,
  },
};
