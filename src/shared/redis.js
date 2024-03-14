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

  const endHandlerClient = (err) => {
    cds.log(COMPONENT_NAME).error("redis client connection closed for pub/sub", err);
    mainClientPromise = null;
    setTimeout(createMainClientAndConnect, 5 * 1000).unref();
  };

  mainClientPromise = createClientAndConnect(errorHandlerCreateClient, endHandlerClient);
  return mainClientPromise;
};

const _createClientBase = () => {
  const env = getEnvInstance();
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
};

const createClientAndConnect = async (errorHandlerCreateClient, endHandler = () => {}) => {
  let client = null;
  try {
    client = _createClientBase();
  } catch (err) {
    throw EventQueueError.redisConnectionFailure(err);
  }

  try {
    await client.connect();
  } catch (err) {
    errorHandlerCreateClient(err);
  }

  client.on("error", (err) => {
    cds.log(COMPONENT_NAME).error("error from redis client for pub/sub failed", err);
  });

  client.on("end", endHandler);

  client.on("reconnecting", () => {
    cds.log(COMPONENT_NAME).error("redis client trying reconnect...");
  });

  return client;
};

const subscribeRedisChannel = (channel, subscribeHandler) => {
  const errorHandlerCreateClient = (err) => {
    cds.log(COMPONENT_NAME).error(`error from redis client for pub/sub failed for channel ${channel}`, err);
    subscriberChannelClientPromise[channel] = null;
    setTimeout(() => subscribeRedisChannel(channel, subscribeHandler), 5 * 1000).unref();
  };
  const endHanlderClient = () => {
    cds.log(COMPONENT_NAME).error(`redis connection closed for channel ${channel}`);
    subscriberChannelClientPromise[channel] = null;
    setTimeout(() => subscribeRedisChannel(channel, subscribeHandler), 5 * 1000).unref();
  };

  subscriberChannelClientPromise[channel] = createClientAndConnect(errorHandlerCreateClient, endHanlderClient)
    .then((client) => {
      cds.log(COMPONENT_NAME).info("subscribe redis client connected channel", { channel });
      client.subscribe(channel, subscribeHandler).catch(errorHandlerCreateClient);
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

const closeMainClient = async () => {
  try {
    await _resilientClientClose(await mainClientPromise);
  } catch (err) {
    // ignore errors during shutdown
  }
};

const _resilientClientClose = async (client) => {
  try {
    if (client?.quit) {
      await client.quit();
    }
  } catch (err) {
    // ignore errors during shutdown
  }
};

const connectionCheck = async () => {
  return new Promise((resolve, reject) => {
    createClientAndConnect(reject)
      .then((client) => {
        if (client) {
          _resilientClientClose(client);
          resolve();
        } else {
          reject(new Error());
        }
      })
      .catch(reject);
  })
    .then(() => true)
    .catch(() => false);
};

module.exports = {
  createClientAndConnect,
  createMainClientAndConnect,
  subscribeRedisChannel,
  publishMessage,
  closeMainClient,
  connectionCheck,
};
