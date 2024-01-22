"use strict";

const redis = require("redis");

const { getEnvInstance } = require("./env");
const EventQueueError = require("../EventQueueError");

const COMPONENT_NAME = "/eventQueue/shared/redis";

let mainClientPromise;
const subscriberChannelClientPromise = {};

const createMainClientAndConnect = () => {
  if (mainClientPromise) {
    return mainClientPromise;
  }

  const errorHandlerCreateClient = (err) => {
    cds.log(COMPONENT_NAME).error("error from redis client for pub/sub failed", err);
    mainClientPromise = null;
    setTimeout(createMainClientAndConnect, 5 * 1000).unref();
  };
  mainClientPromise = createClientAndConnect(errorHandlerCreateClient);
  return mainClientPromise;
};

const _createClientBase = () => {
  const env = getEnvInstance();
  if (env.isOnCF) {
    try {
      const credentials = env.getRedisCredentialsFromEnv();
      const redisIsCluster = credentials.cluster_mode;
      const url = credentials.uri.replace(/(?<=rediss:\/\/)[\w-]+?(?=:)/, "");
      if (redisIsCluster) {
        return redis.createCluster({
          rootNodes: [{ url }],
          // https://github.com/redis/node-redis/issues/1782
          defaults: {
            password: credentials.password,
            socket: { tls: credentials.tls },
          },
        });
      }
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
    cds.log(COMPONENT_NAME).error(`error from redis client for pub/sub failed for channel ${channel}`, err);
    subscriberChannelClientPromise[channel] = null;
    setTimeout(() => subscribeRedisChannel(channel, subscribeCb), 5 * 1000).unref();
  };
  subscriberChannelClientPromise[channel] = createClientAndConnect(errorHandlerCreateClient);
  subscriberChannelClientPromise[channel]
    .then((client) => {
      cds.log(COMPONENT_NAME).info("subscribe redis client connected channel", { channel });
      client.subscribe(channel, subscribeCb).catch(errorHandlerCreateClient);
    })
    .catch((err) => {
      cds
        .log(COMPONENT_NAME)
        .error(`error from redis client for pub/sub failed during startup - trying to reconnect - ${channel}`, err);
    });
};

const publishMessage = async (channel, message) => {
  const client = await createMainClientAndConnect();
  return await client.publish(channel, message);
};

const _localReconnectStrategy = () => EventQueueError.redisNoReconnect();

const closeMainClient = async () => {
  try {
    const client = await mainClientPromise;
    if (client?.quit) {
      await client.quit();
    }
  } catch (err) {
    // ignore errors during shutdown
  }
};

module.exports = {
  createClientAndConnect,
  createMainClientAndConnect,
  subscribeRedisChannel,
  publishMessage,
  closeMainClient,
};
