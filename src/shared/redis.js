"use strict";

const { promisify } = require("util");

const redis = require("redis");

const { getEnvInstance } = require("./env");
const EventQueueError = require("../EventQueueError");

const COMPONENT_NAME = "/eventQueue/shared/redis";
const LOG_AFTER_SEC = 5;

let mainClientPromise;
const subscriberChannelClientPromise = {};
let lastErrorLog = Date.now();

const wait = promisify(setTimeout);

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

const _createClientBase = (redisOptions) => {
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
          ...redisOptions,
        },
      });
    }
    return redis.createClient({ url, ...redisOptions });
  } catch (err) {
    throw EventQueueError.redisConnectionFailure(err);
  }
};

const createClientAndConnect = async (options, errorHandlerCreateClient) => {
  try {
    await (cds.env.requires.telemetry ? waitForTelemetry() : Promise.resolve());
    const client = _createClientBase(options);
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

const waitForTelemetry = async () => {
  while (true) {
    if (cds._telemetry) {
      return;
    } else {
      await wait(1000);
    }
  }
};

const connectionCheck = async (options) => {
  return new Promise((resolve, reject) => {
    createClientAndConnect(options, reject)
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
