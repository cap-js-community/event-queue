"use strict";

const redis = require("./redis");
const config = require("../config");
const cdsHelper = require("./cdsHelper");

const existingLocks = {};
const REDIS_COMMAND_OK = "OK";
const COMPONENT_NAME = "/eventQueue/distributedLock";

const acquireLock = async (
  context,
  key,
  { tenantScoped = true, expiryTime = config.globalTxTimeout, keepTrackOfLock = false } = {}
) => {
  const fullKey = _generateKey(context, tenantScoped, key);
  if (config.redisEnabled) {
    return await _acquireLockRedis(context, fullKey, expiryTime, { keepTrackOfLock });
  } else {
    return await _acquireLockDB(context, fullKey, expiryTime, { keepTrackOfLock });
  }
};

const renewLock = async (context, key, { tenantScoped = true, expiryTime = config.globalTxTimeout } = {}) => {
  const fullKey = _generateKey(context, tenantScoped, key);
  if (config.redisEnabled) {
    return await _renewLockRedis(context, fullKey, expiryTime);
  } else {
    return await _acquireLockDB(context, fullKey, expiryTime, { overrideValue: true });
  }
};

const setValueWithExpire = async (
  context,
  key,
  value,
  { tenantScoped = true, expiryTime = config.globalTxTimeout, overrideValue = false, keepTrackOfLock = false } = {}
) => {
  const fullKey = _generateKey(context, tenantScoped, key);
  if (config.redisEnabled) {
    return await _acquireLockRedis(context, fullKey, expiryTime, {
      value,
      overrideValue,
      keepTrackOfLock,
    });
  } else {
    return await _acquireLockDB(context, fullKey, expiryTime, {
      value,
      overrideValue,
    });
  }
};

const releaseLock = async (context, key, { tenantScoped = true } = {}) => {
  const fullKey = _generateKey(context, tenantScoped, key);
  if (config.redisEnabled) {
    return await _releaseLockRedis(context, fullKey);
  } else {
    return await _releaseLockDb(context, fullKey);
  }
};

const checkLockExistsAndReturnValue = async (context, key, { tenantScoped = true } = {}) => {
  const fullKey = _generateKey(context, tenantScoped, key);
  if (config.redisEnabled) {
    return await _checkLockExistsRedis(context, fullKey);
  } else {
    return await _checkLockExistsDb(context, fullKey);
  }
};

const _acquireLockRedis = async (
  context,
  fullKey,
  expiryTime,
  { value = Date.now(), overrideValue = false, keepTrackOfLock } = {}
) => {
  const client = await redis.createMainClientAndConnect(config.redisOptions);
  const result = await client.set(fullKey, value, {
    PX: Math.round(expiryTime),
    ...(overrideValue ? null : { NX: true }),
  });
  const isOk = result === REDIS_COMMAND_OK;
  if (isOk && keepTrackOfLock) {
    existingLocks[fullKey] = context.tenant;
  }
  return isOk;
};

const _renewLockRedis = async (context, fullKey, expiryTime, { value = "true" } = {}) => {
  const client = await redis.createMainClientAndConnect(config.redisOptions);
  let result = await client.set(fullKey, value, {
    PX: Math.round(expiryTime),
    XX: true,
  });

  if (result !== REDIS_COMMAND_OK) {
    const readResult = await client.get(fullKey);
    if (!readResult) {
      result = await client.set(fullKey, value, {
        PX: Math.round(expiryTime),
      });
    }
  }

  return result === REDIS_COMMAND_OK;
};

const _checkLockExistsRedis = async (context, fullKey) => {
  const client = await redis.createMainClientAndConnect(config.redisOptions);
  return await client.exists(fullKey);
};

const _checkLockExistsDb = async (context, fullKey) => {
  let result;
  await cdsHelper.executeInNewTransaction(context, "distributedLock-checkExists", async (tx) => {
    result = await tx.run(SELECT.one.from(config.tableNameEventLock).where("code =", fullKey));
  });
  return result?.value;
};

const _releaseLockRedis = async (context, fullKey) => {
  const client = await redis.createMainClientAndConnect(config.redisOptions);
  const result = await client.del(fullKey);
  delete existingLocks[fullKey];
  return result === 1;
};

const _releaseLockDb = async (context, fullKey) => {
  await cdsHelper.executeInNewTransaction(context, "distributedLock-release", async (tx) => {
    await tx.run(DELETE.from(config.tableNameEventLock).where("code =", fullKey));
  });
  delete existingLocks[fullKey];
  return true;
};

const _acquireLockDB = async (
  context,
  fullKey,
  expiryTime,
  { value = "true", overrideValue = false, keepTrackOfLock } = {}
) => {
  let result;
  await cdsHelper.executeInNewTransaction(context, "distributedLock-acquire", async (tx) => {
    try {
      await tx.run(
        INSERT.into(config.tableNameEventLock).entries({
          code: fullKey,
          value,
        })
      );
      result = true;
    } catch (err) {
      let currentEntry;

      if (!overrideValue) {
        currentEntry = await tx.run(
          SELECT.one
            .from(config.tableNameEventLock)
            .forUpdate({ wait: config.forUpdateTimeout })
            .where("code =", fullKey)
        );
      }
      if (
        overrideValue ||
        (currentEntry && new Date(currentEntry.createdAt).getTime() + Math.round(expiryTime) <= Date.now())
      ) {
        await tx.run(
          UPDATE.entity(config.tableNameEventLock)
            .set({
              createdAt: new Date().toISOString(),
              value,
            })
            .where("code =", fullKey)
        );
        result = true;
      } else {
        result = false;
      }
    }
  });
  if (result && keepTrackOfLock) {
    existingLocks[fullKey] = context.tenant;
  }
  return result;
};

const _generateKey = (context, tenantScoped, key) => {
  const keyParts = [config.redisOptions.redisNamespace];
  tenantScoped && keyParts.push(context.tenant);
  keyParts.push(key);
  return `${keyParts.join("##")}`;
};

const getAllLocksRedis = async () => {
  const clientOrCluster = await redis.createMainClientAndConnect(config.redisOptions);
  const output = [];
  const results = [];

  let clients;
  if (redis.isClusterMode()) {
    clients = clientOrCluster.masters.map((master) => master.client);
  } else {
    clients = [clientOrCluster];
  }

  // NOTE: use SCAN because KEYS is not supported for cluster clients
  for (const client of clients) {
    for await (const key of client.scanIterator({ MATCH: "EVENT*", COUNT: 1000 })) {
      const [, tenant, guidOrType, subType] = key.split("##");
      if (!subType) {
        continue;
      }

      const pipeline = client.multi();
      output.push({
        tenant: tenant,
        type: guidOrType,
        subType: subType,
      });
      pipeline.ttl(key).get(key);
      const replies = await pipeline.exec();
      results.push(...replies);
    }
  }

  let counter = 0;
  for (const row of output) {
    const ttl = results[counter];
    const createdAt = results[counter + 1];
    Object.assign(row, { ttl, createdAt });
    counter = counter + 2;
  }
  return output;
};

const shutdownHandler = async () => {
  const logger = cds.log(COMPONENT_NAME);
  logger.info("received shutdown event, trying to release all locks", {
    numberOfLocks: Object.keys(existingLocks).length,
  });
  const result = await Promise.allSettled(
    Object.entries(existingLocks).map(async ([key, tenant]) => {
      if (config.redisEnabled) {
        await _releaseLockRedis({ tenant }, key);
      } else {
        await _releaseLockDb({ tenant }, key);
      }
      logger.info("lock released", { key });
    })
  );
  const errors = result.filter((promise) => promise.reason);
  logger.info("releasing locks finished ", {
    numberOfErrors: errors.length,
    ...(errors.length && { firstError: errors[0] }),
  });
};

module.exports = {
  acquireLock,
  releaseLock,
  checkLockExistsAndReturnValue,
  setValueWithExpire,
  shutdownHandler,
  renewLock,
  getAllLocksRedis,
};
