"use strict";

const redis = require("redis");

const { getEnvInstance } = require("./env");
const EventQueueError = require("../EventQueueError");

const COMPONENT_NAME = "/eventQueue/shared/redis";
const LOG_AFTER_SEC = 5;

let mainClientPromise;
const subscriberChannelClientPromise = {};
let lastErrorLog = Date.now();

const createMainClientAndConnect = () => {
  if (mainClientPromise) {
    return mainClientPromise;
  }

  const errorHandlerCreateClient = (err) => {
    cds.log(COMPONENT_NAME).error("error from redis client for pub/sub failed", err);
    mainClientPromise = null;
    setTimeout(createMainClientAndConnect, LOG_AFTER_SEC * 1000).unref();
  };

  mainClientPromise = createClientAndConnect(errorHandlerCreateClient);
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

const createClientAndConnect = async (errorHandlerCreateClient) => {
  try {
    const client = _createClientBase();
    await client.connect();
    client.on("error", (err) => {
      const dateNow = Date.now();
      if (dateNow - lastErrorLog > LOG_AFTER_SEC * 1000) {
        cds.log(COMPONENT_NAME).error("error from redis client for pub/sub failed", err);
        lastErrorLog = dateNow;
      }
    });

    client.on("reconnecting", () => {
      const dateNow = Date.now();
      if (dateNow - lastErrorLog > LOG_AFTER_SEC * 1000) {
        cds.log(COMPONENT_NAME).info("redis client trying reconnect...");
        lastErrorLog = dateNow;
      }
    });
    return client;
  } catch (err) {
    errorHandlerCreateClient(err);
  }
};

const subscribeRedisChannel = (channel, subscribeHandler) => {
  const errorHandlerCreateClient = (err) => {
    cds.log(COMPONENT_NAME).error(`error from redis client for pub/sub failed for channel ${channel}`, err);
    subscriberChannelClientPromise[channel] = null;
    setTimeout(() => subscribeRedisChannel(channel, subscribeHandler), LOG_AFTER_SEC * 1000).unref();
  };

  subscriberChannelClientPromise[channel] = createClientAndConnect(errorHandlerCreateClient)
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
        console.error("connection check result %o", client);
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
