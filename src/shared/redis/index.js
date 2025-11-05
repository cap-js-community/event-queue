"use strict";

const cds = require("@sap/cds");

const client = require("./client");
const config = require("../../config");

const COMPONENT_NAME = "/eventQueue/redis";
const REDIS_OFFBOARD_TENANT_CHANNEL = "REDIS_OFFBOARD_TENANT_CHANNEL";

const attachRedisUnsubscribeHandler = () => {
  cds.log(COMPONENT_NAME).info("attached redis handle for unsubscribe events");
  client
    .subscribeRedisChannel(REDIS_OFFBOARD_TENANT_CHANNEL, (messageData) => {
      try {
        const { tenantId } = JSON.parse(messageData);
        cds.log(COMPONENT_NAME).info("received unsubscribe broadcast event", { tenantId });
        this.executeUnsubscribeHandlers(tenantId);
      } catch (err) {
        cds.log(COMPONENT_NAME).error("could not parse unsubscribe broadcast event", err, {
          messageData,
        });
      }
    })
    .catch((err) => _errorHandlerSubscribeChannel(REDIS_OFFBOARD_TENANT_CHANNEL, err));
};

const handleUnsubscribe = (tenantId) => {
  if (config.redisEnabled) {
    client.publishMessage(REDIS_OFFBOARD_TENANT_CHANNEL, JSON.stringify({ tenantId })).catch((error) => {
      cds.log(COMPONENT_NAME).error(`publishing tenant unsubscribe failed. tenantId: ${tenantId}`, error);
    });
  } else {
    config.executeUnsubscribeHandlers(tenantId);
  }
};

const _errorHandlerSubscribeChannel = (channelName, err) =>
  cds.log(COMPONENT_NAME).error("error subscribing to channel", err, { channelName });

module.exports = {
  ...client,
  attachRedisUnsubscribeHandler,
  handleUnsubscribe,
};
