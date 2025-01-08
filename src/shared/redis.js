"use strict";

const redis = require("redis");

const { getEnvInstance } = require("./env");
const EventQueueError = require("../EventQueueError");

const COMPONENT_NAME = "/eventQueue/shared/redis";
const LOG_AFTER_SEC = 5;

let mainClientPromise;
const subscriberChannelClientPromise = {};
let lastErrorLog = Date.now();

const createMainClientAndConnect = (options) => {
  if (mainClientPromise) {
    return mainClientPromise;
  }

  const errorHandlerCreateClient = (err) => {
    cds.log(COMPONENT_NAME).error("error from redis client for pub/sub failed", err);
    mainClientPromise = null;
    setTimeout(() => createMainClientAndConnect(options), LOG_AFTER_SEC * 1000).unref();
  };

  mainClientPromise = createClientAndConnect(options, errorHandlerCreateClient);
  return mainClientPromise;
};

const _createClientBase = (redisOptions = {}) => {
  const env = getEnvInstance();
  try {
    const { credentials, options } = env.redisRequires;
    const socket = Object.assign(
      {
        host: credentials.hostname,
        tls: !!credentials.tls,
        port: credentials.port,
      },
      options?.socket,
      redisOptions.socket
    );
    const socketOptions = Object.assign({}, options, redisOptions, {
      password: redisOptions.password ?? options.password ?? credentials.password,
      socket,
    });
    if (credentials.cluster_mode) {
      return redis.createCluster({
        rootNodes: [socketOptions],
        defaults: socketOptions,
      });
    }
    return redis.createClient(socketOptions);
  } catch (err) {
    throw EventQueueError.redisConnectionFailure(err);
  }
};

const createClientAndConnect = async (options, errorHandlerCreateClient, isConnectionCheck) => {
  try {
    const client = _createClientBase(options);
    if (!isConnectionCheck) {
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
    }
    await client.connect();
    return client;
  } catch (err) {
    errorHandlerCreateClient(err);
  }
};

const subscribeRedisChannel = (options, channel, subscribeHandler) => {
  const errorHandlerCreateClient = (err) => {
    cds.log(COMPONENT_NAME).error(`error from redis client for pub/sub failed for channel ${channel}`, err);
    subscriberChannelClientPromise[channel] = null;
    setTimeout(() => subscribeRedisChannel(options, channel, subscribeHandler), LOG_AFTER_SEC * 1000).unref();
  };

  subscriberChannelClientPromise[channel] = createClientAndConnect(options, errorHandlerCreateClient)
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

const publishMessage = async (options, channel, message) => {
  const client = await createMainClientAndConnect(options);
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

const connectionCheck = async (options) => {
  return new Promise((resolve, reject) => {
    createClientAndConnect(options, reject, true)
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
    .catch((err) => {
      cds.log(COMPONENT_NAME).error("Redis connection check failed! Falling back to NO_REDIS mode", err);
      return false;
    });
};

module.exports = {
  createClientAndConnect,
  createMainClientAndConnect,
  subscribeRedisChannel,
  publishMessage,
  closeMainClient,
  connectionCheck,
};
