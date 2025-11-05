"use strict";

const { RedisClient } = require("@cap-js-community/common");

const config = require("../../config");

const REDIS_CLIENT_NAME = "eventQueue";

const createMainClientAndConnect = async () => {
  const redisClient = RedisClient.default(REDIS_CLIENT_NAME);
  return await redisClient.createMainClientAndConnect(config.redisOptions);
};

const subscribeRedisChannel = async (channel, subscribeHandler) => {
  const redisClient = RedisClient.default(REDIS_CLIENT_NAME);
  const channelWithNamespace = [config.redisNamespace, channel].join("_");
  return await redisClient.subscribeChannel(config.redisOptions, channelWithNamespace, subscribeHandler);
};

const publishMessage = async (channel, message) => {
  const redisClient = RedisClient.default(REDIS_CLIENT_NAME);
  const channelWithNamespace = [config.redisNamespace, channel].join("_");
  return await redisClient.publishMessage(config.redisOptions, channelWithNamespace, message);
};

const connectionCheck = async () => {
  const redisClient = RedisClient.default(REDIS_CLIENT_NAME);
  return await redisClient.connectionCheck(config.redisOptions);
};

const isClusterMode = () => {
  return RedisClient.default(REDIS_CLIENT_NAME).isCluster;
};

const registerShutdownHandler = (cb) => {
  RedisClient.default(REDIS_CLIENT_NAME).beforeCloseHandler = cb;
};

module.exports = {
  createMainClientAndConnect,
  subscribeRedisChannel,
  publishMessage,
  connectionCheck,
  isClusterMode,
  registerShutdownHandler,
};
