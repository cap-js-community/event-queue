"use strict";

const redis = require("redis");

const { getEnvInstance } = require("./env");
const EventQueueError = require("../EventQueueError");

const COMPONENT_NAME = "/eventQueue/shared/redis";
const LOG_AFTER_SEC = 5;

let mainClientPromise;
let subscriberClientPromise;
const subscribedChannels = {};
let lastErrorLog = Date.now();

const createMainClientAndConnect = (options) => {
  if (mainClientPromise) {
    return mainClientPromise;
  }

  const errorHandlerCreateClient = (err) => {
    mainClientPromise?.then?.(_resilientClientClose);
    cds.log(COMPONENT_NAME).error("error from redis main client:", err);
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
    delete socketOptions.redisNamespace;
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
          cds.log(COMPONENT_NAME).error("error redis client:", err);
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
  subscribedChannels[channel] = subscribeHandler;
  const errorHandlerCreateClient = (err) => {
    cds.log(COMPONENT_NAME).error(`error from redis client for pub/sub failed for channel ${channel}`, err);
    subscriberClientPromise?.then?.(_resilientClientClose);
    subscriberClientPromise = null;
    setTimeout(() => _subscribeChannels(options, subscribedChannels, subscribeHandler), LOG_AFTER_SEC * 1000).unref();
  };

  _subscribeChannels(options, { [channel]: subscribeHandler }, errorHandlerCreateClient);
};

const _subscribeChannels = (options, subscribedChannels, errorHandlerCreateClient) => {
  subscriberClientPromise = createClientAndConnect(options, errorHandlerCreateClient)
    .then((client) => {
      for (const channel in subscribedChannels) {
        const fn = subscribedChannels[channel];
        client._subscribedChannels ??= {};
        if (client._subscribedChannels[channel]) {
          continue;
        }
        const prefixedChannelName = [options.redisNamespace, channel].join("_");
        cds.log(COMPONENT_NAME).info("subscribe redis client connected channel", { channel: prefixedChannelName });
        client
          .subscribe(prefixedChannelName, fn)
          .then(() => {
            client._subscribedChannels ??= {};
            client._subscribedChannels[channel] = 1;
          })
          .catch(() => {
            cds.log(COMPONENT_NAME).error("error subscribe to channel - retrying...");
            setTimeout(() => _subscribeChannels(options, [channel], fn), LOG_AFTER_SEC * 1000).unref();
          });
      }
    })
    .catch((err) => {
      cds
        .log(COMPONENT_NAME)
        .error(
          `error from redis client for pub/sub failed during startup - trying to reconnect - ${Object.keys(
            subscribedChannels
          ).join(", ")}`,
          err
        );
    });
};

const publishMessage = async (options, channel, message) => {
  const client = await createMainClientAndConnect(options);
  return await client.publish([options.redisNamespace, channel].join("_"), message);
};

const closeMainClient = async () => {
  await _resilientClientClose(await mainClientPromise);
  cds.log(COMPONENT_NAME).info("main redis client closed!");
};

const closeSubscribeClient = async () => {
  await _resilientClientClose(await subscriberClientPromise);
  cds.log(COMPONENT_NAME).info("subscribe redis client closed!");
};

const _resilientClientClose = async (client) => {
  try {
    if (client?.quit) {
      await client.quit();
    }
  } catch (err) {
    cds.log(COMPONENT_NAME).info("error during redis close - continuing...", err);
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

const isClusterMode = () => {
  if (!("__clusterMode" in isClusterMode)) {
    const env = getEnvInstance();
    const { credentials } = env.redisRequires;
    isClusterMode.__clusterMode = credentials.cluster_mode;
  }
  return isClusterMode.__clusterMode;
};

module.exports = {
  createClientAndConnect,
  createMainClientAndConnect,
  subscribeRedisChannel,
  publishMessage,
  closeMainClient,
  closeSubscribeClient,
  connectionCheck,
  isClusterMode,
};
