"use strict";

const redis = require("redis");

const config = require("../config");
const EventQueueError = require("../EventQueueError");

const COMPONENT_NAME = "eventQueue/shared/redis";

let subscriberClientPromise;

const createMainClientAndConnect = () => {
  if (subscriberClientPromise) {
    return subscriberClientPromise;
  }

  const errorHandlerCreateClient = (err) => {
    cds.log(COMPONENT_NAME).error("error from redis client for pub/sub failed", err);
    subscriberClientPromise = null;
    setTimeout(createMainClientAndConnect, 5 * 1000).unref();
  };
  subscriberClientPromise = createClientAndConnect(errorHandlerCreateClient);
  return subscriberClientPromise;
};

const _createClientBase = () => {
  const configInstance = config.getConfigInstance();
  if (configInstance.isOnCF) {
    try {
      const credentials = configInstance.getRedisCredentialsFromEnv();
      // NOTE: settings the user explicitly to empty resolves auth problems, see
      // https://github.com/go-redis/redis/issues/1343
      const url = credentials.uri.replace(/(?<=rediss:\/\/)[\w-]+?(?=:)/, "");
      return redis.createClient({ url });
    } catch (err) {
      throw EventQueueError.redisConnectionFailure(err);
    }
  } else {
    return redis.createClient({
      socket: { reconnectStrategy: _localReconnectStrategy },
    });
  }
};

const createClientAndConnect = async (errorHandlerCreateClient) => {
  let client = null;
  try {
    client = _createClientBase();
  } catch (err) {
    throw EventQueueError.redisConnectionFailure(err);
  }

  client.on("error", errorHandlerCreateClient);

  try {
    await client.connect();
  } catch (err) {
    errorHandlerCreateClient(err);
  }
  return client;
};

const _localReconnectStrategy = () => EventQueueError.redisNoReconnect();

module.exports = {
  createClientAndConnect,
  createMainClientAndConnect,
};
