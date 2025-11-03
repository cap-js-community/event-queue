"use strict";

const { RedisClient } = require("@cap-js-community/common");

const { getEnvInstance } = require("../env");
const config = require("../../config");

const REDIS_CLIENT_NAME = "eventQueue";

const createMainClientAndConnect = async () => {
  // TODO: why websockets: options?.config
  const redisClient = RedisClient.default(REDIS_CLIENT_NAME);
  return await redisClient.createMainClientAndConnect(config.redisOptions);
};

const subscribeRedisChannel = async (channel, subscribeHandler) => {
  // TODO: why websockets: options?.config
  const redisClient = RedisClient.default(REDIS_CLIENT_NAME);
  const channelWithNamespace = [config.redisNamespace, channel].join("_");
  return await redisClient.subscribeChannel(config.redisOptions, channelWithNamespace, subscribeHandler);
};

const publishMessage = async (channel, message) => {
  // TODO: why websockets: options?.config
  const redisClient = RedisClient.default(REDIS_CLIENT_NAME);
  const channelWithNamespace = [config.redisNamespace, channel].join("_");
  return await redisClient.publish(config.redisOptions, channelWithNamespace, message);
};

const connectionCheck = async () => {
  // TODO: why websockets: options?.config
  const redisClient = RedisClient.default(REDIS_CLIENT_NAME);
  return await redisClient.connectionCheck(config.redisOptions);
};

const isClusterMode = () => {
  if (!("__clusterMode" in isClusterMode)) {
    const env = getEnvInstance();
    const { credentials } = env.redisRequires;
    isClusterMode.__clusterMode = credentials.cluster_mode;
  }
  return isClusterMode.__clusterMode;
};

module.exports = {
  createMainClientAndConnect,
  subscribeRedisChannel,
  publishMessage,
  connectionCheck,
  isClusterMode,
};
