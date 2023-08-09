"use strict";

const redis = require("redis");

const config = require("../config");
const EventQueueError = require("../EventQueueError");

const COMPONENT_NAME = "eventQueue/shared/redis";
const LOGGER = cds.log(COMPONENT_NAME);

let mainClientPromise;
const subscriberChannelClientPromise = {};

const createMainClientAndConnect = () => {
  if (mainClientPromise) {
    return mainClientPromise;
  }

  const errorHandlerCreateClient = (err) => {
    LOGGER.error("error from redis client for pub/sub failed", err);
    mainClientPromise = null;
    setTimeout(createMainClientAndConnect, 5 * 1000).unref();
  };
  mainClientPromise = createClientAndConnect(errorHandlerCreateClient);
  return mainClientPromise;
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

const subscribeRedisChannel = (channel, subscribeCb) => {
  const errorHandlerCreateClient = (err) => {
    LOGGER.error(`error from redis client for pub/sub failed for channel ${channel}`, err);
    subscriberChannelClientPromise[channel] = null;
    setTimeout(() => subscribeRedisChannel(channel, subscribeCb), 5 * 1000).unref();
  };
  subscriberChannelClientPromise[channel] = redis.createClientAndConnect(errorHandlerCreateClient);
  subscriberChannelClientPromise[channel]
    .then((client) => {
      LOGGER.info("subscribe redis client connected");
      client.subscribe(channel, subscribeCb);
    })
    .catch((err) => {
      cds
        .log(COMPONENT_NAME)
        .error(`error from redis client for pub/sub failed during startup - trying to reconnect - ${channel} `, err);
    });
};

const publishMessage = async (channel, message) => {
  const client = await createMainClientAndConnect();
  return await client.publish(channel, message);
};

const _localReconnectStrategy = () => EventQueueError.redisNoReconnect();

module.exports = {
  createClientAndConnect,
  createMainClientAndConnect,
  subscribeRedisChannel,
  publishMessage,
};
